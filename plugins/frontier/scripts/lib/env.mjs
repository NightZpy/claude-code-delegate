import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const FRONTIER_HOME = path.join(os.homedir(), ".claude", "frontier");
export const ENV_FILE = path.join(FRONTIER_HOME, ".env");
export const USAGE_LEDGER_FILE = path.join(FRONTIER_HOME, "usage.jsonl");

export function maskKey(value) {
  if (!value) {
    return "not set";
  }
  const key = String(value);
  if (key.length <= 14) {
    return `****${key.slice(-4)}`;
  }
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function parseEnv(text) {
  const values = {};

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

export async function readEnvFile() {
  try {
    const text = await fs.readFile(ENV_FILE, "utf8");
    return parseEnv(text);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function loadKeys() {
  const envFileValues = await readEnvFile();

  for (const [key, value] of Object.entries(envFileValues)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return {
    envFile: ENV_FILE,
    values: {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
      SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY ?? "",
      DEEPINFRA_API_KEY: process.env.DEEPINFRA_API_KEY ?? "",
      CEREBRAS_API_KEY: process.env.CEREBRAS_API_KEY ?? "",
    },
    fileValues: envFileValues,
  };
}
