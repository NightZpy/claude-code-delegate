import fs from "node:fs/promises";
import path from "node:path";
import { FRONTIER_HOME } from "./env.mjs";

export const CONFIG_FILE = path.join(FRONTIER_HOME, "config.json");

export async function loadConfig() {
  try {
    const text = await fs.readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(text);
    const quotas = parsed && typeof parsed.quotas === "object" && parsed.quotas !== null ? parsed.quotas : {};
    return { quotas };
  } catch {
    return { quotas: {} };
  }
}

export async function saveConfig(config) {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await fs.writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
