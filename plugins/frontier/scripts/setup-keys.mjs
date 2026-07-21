import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { ENV_FILE, maskKey, readEnvFile } from "./lib/env.mjs";
import { loadConfig, saveConfig } from "./lib/config.mjs";
import { renderProviderGuide } from "./lib/providerGuide.mjs";
import { terminalStyles } from "./lib/styles.mjs";
import { padVisible } from "./lib/ansi.mjs";

const PROVIDER_KEYS = [
  { name: "openrouter", envKey: "OPENROUTER_API_KEY", defaultQuota: 10 },
  { name: "siliconflow", envKey: "SILICONFLOW_API_KEY", defaultQuota: 5 },
  { name: "deepinfra", envKey: "DEEPINFRA_API_KEY", defaultQuota: 5 },
  { name: "cerebras", envKey: "CEREBRAS_API_KEY", defaultQuota: 5 },
];

async function writeEnv(values) {
  const dir = path.dirname(ENV_FILE);
  await fs.mkdir(dir, { recursive: true });
  const lines = ["# frontier companion provider keys"];
  for (const { envKey } of PROVIDER_KEYS) {
    if (values[envKey]) {
      lines.push(`${envKey}=${values[envKey]}`);
    }
  }
  await fs.writeFile(ENV_FILE, `${lines.join("\n")}\n`, "utf8");
  await fs.chmod(ENV_FILE, 0o600);
}

function questionHidden(rl, prompt) {
  // Unix-password-style input: echo '*' instead of the typed characters.
  const original = rl._writeToOutput;
  rl._writeToOutput = function (str) {
    if (str.includes(prompt)) {
      original.call(rl, prompt);
      return;
    }
    if (str === "\r\n" || str === "\n") {
      original.call(rl, str);
      return;
    }
    original.call(rl, "*");
  };
  return rl.question(prompt).finally(() => {
    rl._writeToOutput = original;
    output.write("\n");
  });
}

async function loadModelsRegistry() {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "models.json");
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text).models || {};
}

async function main() {
  const styles = terminalStyles(output);
  const models = await loadModelsRegistry();
  output.write(`${renderProviderGuide(models, styles, output.columns || 100)}\n\n`);

  const existing = await readEnvFile();
  const rl = readline.createInterface({ input, output });
  const next = { ...existing };

  try {
    output.write(`Writing keys to ${ENV_FILE}\n`);
    output.write(`Home: ${os.homedir()}\n\n`);

    for (const [index, provider] of PROVIDER_KEYS.entries()) {
      const current = existing[provider.envKey] || "";
      output.write(`${styles.bold(`[${index + 1}/${PROVIDER_KEYS.length}] ${provider.name}`)}\n`);
      output.write(`  ${current ? styles.green(`stored ${maskKey(current)}`) : styles.dim("not stored")}\n`);
      const answer = await questionHidden(rl, "  paste key or press Enter to keep/skip: ");
      const trimmed = answer.trim();
      if (trimmed) {
        next[provider.envKey] = trimmed;
        output.write(`  ${styles.green("✓ saved")}\n`);
      }
      output.write("\n");
    }
  } finally {
    rl.close();
  }

  await writeEnv(next);

  const config = await loadConfig();
  const configuredProviders = PROVIDER_KEYS.filter((provider) => next[provider.envKey]);

  if (configuredProviders.length) {
    output.write(`${styles.bold("Monthly spend quotas (USD, optional)")}\n`);
    const rl2 = readline.createInterface({ input, output });
    try {
      for (const [index, provider] of configuredProviders.entries()) {
        const current = config.quotas[provider.name];
        output.write(`${styles.bold(`[${index + 1}/${configuredProviders.length}] ${provider.name}`)}\n`);
        output.write(
          `  ${current !== undefined ? `current $${current}` : styles.dim(`not set (default $${provider.defaultQuota})`)}\n`,
        );
        const answer = await rl2.question(
          `  monthly quota USD [Enter keeps current/default, "0" or "none" disables]: `,
        );
        const trimmed = answer.trim().toLowerCase();
        if (trimmed === "") {
          config.quotas[provider.name] = current !== undefined ? current : provider.defaultQuota;
        } else if (trimmed === "0" || trimmed === "none") {
          delete config.quotas[provider.name];
        } else {
          const parsed = Number(trimmed);
          if (Number.isFinite(parsed) && parsed > 0) {
            config.quotas[provider.name] = parsed;
          }
        }
        output.write(`  ${styles.green("✓ saved")}\n\n`);
      }
    } finally {
      rl2.close();
    }
    await saveConfig(config);
  }

  const nameWidth = Math.max(...PROVIDER_KEYS.map((provider) => provider.name.length));
  const summary = PROVIDER_KEYS.map((provider) => {
    const value = next[provider.envKey] || "";
    const quota = config.quotas[provider.name];
    const keyMark = value ? styles.green("✓") : styles.dim("–");
    const quotaMark = value && quota !== undefined ? styles.green("✓") : styles.dim("–");
    const keyCol = value ? `key ${keyMark} ${maskKey(value)}` : `key ${keyMark} not configured`;
    const quotaCol =
      value && quota !== undefined ? `quota ${quotaMark} $${quota}/mo` : `quota ${quotaMark} disabled`;
    return `  ${provider.name.padEnd(nameWidth)}  ${padVisible(keyCol, 28)}  ${quotaCol}`;
  });

  output.write(`${styles.bold("Configured providers")}\n`);
  output.write(`${summary.join("\n")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
