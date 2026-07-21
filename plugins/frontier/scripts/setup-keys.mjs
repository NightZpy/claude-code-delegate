import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { ENV_FILE, maskKey, readEnvFile } from "./lib/env.mjs";
import { loadConfig, saveConfig } from "./lib/config.mjs";
import { renderProviderGuide } from "./lib/providerGuide.mjs";

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
  const models = await loadModelsRegistry();
  output.write(`${renderProviderGuide(models)}\n\n`);

  const existing = await readEnvFile();
  const rl = readline.createInterface({ input, output });
  const next = { ...existing };

  try {
    output.write(`Writing keys to ${ENV_FILE}\n`);
    output.write(`Home: ${os.homedir()}\n\n`);

    for (const provider of PROVIDER_KEYS) {
      const current = existing[provider.envKey] || "";
      output.write(`${provider.name}: ${current ? `stored ${maskKey(current)}` : "not stored"}\n`);
      const answer = await questionHidden(rl, "paste key or press Enter to keep/skip: ");
      const trimmed = answer.trim();
      if (trimmed) {
        next[provider.envKey] = trimmed;
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
    output.write("Monthly spend quotas (USD, optional)\n");
    const rl2 = readline.createInterface({ input, output });
    try {
      for (const provider of configuredProviders) {
        const current = config.quotas[provider.name];
        output.write(
          `${provider.name}: ${current !== undefined ? `current $${current}` : `not set (default $${provider.defaultQuota})`}\n`,
        );
        const answer = await rl2.question(
          `monthly spend quota USD [default ${provider.defaultQuota} for openrouter, 5 others; current value if already set — Enter keeps it, "0" or "none" disables]: `,
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
        output.write("\n");
      }
    } finally {
      rl2.close();
    }
    await saveConfig(config);
  }

  const summary = PROVIDER_KEYS.map((provider) => {
    const value = next[provider.envKey] || "";
    const quota = config.quotas[provider.name];
    const quotaSuffix = value && quota !== undefined ? ` — quota $${quota}/mo` : value ? " — quota disabled" : "";
    return `${provider.name.padEnd(12)} ${value ? `configured ${maskKey(value)}` : "not configured"}${quotaSuffix}`;
  });

  output.write("Configured providers\n");
  output.write(`${summary.join("\n")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
