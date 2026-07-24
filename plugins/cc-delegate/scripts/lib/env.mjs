import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OLD_HOMES = [
  path.join(os.homedir(), ".claude", "frontier"),
  path.join(os.homedir(), ".claude", "delegate"),
];
export const CC_DELEGATE_HOME = process.env.CC_DELEGATE_HOME || path.join(os.homedir(), ".claude", "cc-delegate");

// One-shot migration: if an old data dir (frontier, then delegate) exists and the
// new one doesn't yet, move it in place so existing usage/config/analysis history
// survives the rename. Only run for the DEFAULT home — skip when the caller
// overrides CC_DELEGATE_HOME to prevent tests from accidentally moving real data.
try {
  if (!process.env.CC_DELEGATE_HOME && !fsSync.existsSync(CC_DELEGATE_HOME)) {
    const oldHome = OLD_HOMES.find((dir) => fsSync.existsSync(dir));
    if (oldHome) {
      fsSync.renameSync(oldHome, CC_DELEGATE_HOME);
    }
  }
} catch {
  // ponytail: migration is best-effort, never block startup on it
}

export const ENV_FILE = path.join(CC_DELEGATE_HOME, ".env");
export const USAGE_LEDGER_FILE = path.join(CC_DELEGATE_HOME, "usage.jsonl");
export const LAST_ANALYSIS_FILE = path.join(CC_DELEGATE_HOME, "last-analysis.md");
export const LAST_ANALYSIS_META_FILE = path.join(CC_DELEGATE_HOME, "last-analysis.json");

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
