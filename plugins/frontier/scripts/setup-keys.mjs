import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ENV_FILE, readEnvFile } from "./lib/env.mjs";

const PROVIDER_KEYS = [
  { name: "openrouter", envKey: "OPENROUTER_API_KEY" },
  { name: "siliconflow", envKey: "SILICONFLOW_API_KEY" },
  { name: "deepinfra", envKey: "DEEPINFRA_API_KEY" },
  { name: "cerebras", envKey: "CEREBRAS_API_KEY" },
];

function maskKey(value) {
  if (!value) {
    return "not set";
  }
  return `****${value.slice(-4)}`;
}

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

async function main() {
  const existing = await readEnvFile();
  const rl = readline.createInterface({ input, output });
  const next = { ...existing };

  try {
    output.write(`Writing keys to ${ENV_FILE}\n`);
    output.write(`Home: ${os.homedir()}\n\n`);

    for (const provider of PROVIDER_KEYS) {
      const current = existing[provider.envKey] || "";
      output.write(`${provider.name}: ${current ? `stored ${maskKey(current)}` : "not stored"}\n`);
      const answer = await rl.question("paste key or press Enter to keep/skip: ");
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

  const summary = PROVIDER_KEYS.map((provider) => {
    const value = next[provider.envKey] || "";
    return `${provider.name.padEnd(12)} ${value ? `configured ${maskKey(value)}` : "not configured"}`;
  });

  output.write("Configured providers\n");
  output.write(`${summary.join("\n")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
