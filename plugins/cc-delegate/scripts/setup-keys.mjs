import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { ENV_FILE, maskKey, readEnvFile } from "./lib/env.mjs";
import { loadConfig, saveConfig } from "./lib/config.mjs";
import { renderProviderGuide, getActiveProviders } from "./lib/providerGuide.mjs";
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
  const lines = ["# cc-delegate companion provider keys"];
  for (const { envKey } of PROVIDER_KEYS) {
    if (values[envKey]) {
      lines.push(`${envKey}=${values[envKey]}`);
    }
  }
  await fs.writeFile(ENV_FILE, `${lines.join("\n")}\n`, "utf8");
  await fs.chmod(ENV_FILE, 0o600);
}

const CTRL_C = Symbol("ctrl-c");

// Real masked input: raw-mode char-by-char read, echoing '*' instead of the
// typed characters. Only usable when stdin/stdout are both real TTYs — a
// pasted chunk arrives as multiple chars at once, so each char in the chunk
// is processed individually and any bytes left over after a terminator
// (Enter/Ctrl-C/Ctrl-D) are pushed back onto stdin with unshift() so the next
// prompt (raw or readline) still sees them.
function readSecret(prompt) {
  output.write(prompt);
  const wasRaw = Boolean(input.isRaw);
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve) => {
    function onData(chunk) {
      for (let i = 0; i < chunk.length; i += 1) {
        const ch = chunk[i];
        const isEnter = ch === "\r" || ch === "\n";
        const isCtrlC = ch === "\x03";
        const isCtrlD = ch === "\x04";

        if (isEnter || isCtrlC || (isCtrlD && buffer.length === 0)) {
          input.removeListener("data", onData);
          const leftover = chunk.slice(i + 1);
          if (leftover) {
            input.unshift(leftover);
          }
          output.write("\n");
          if (isCtrlC) {
            resolve(CTRL_C);
          } else if (isCtrlD) {
            resolve(null);
          } else {
            resolve(buffer);
          }
          return;
        }

        if (ch === "\x7f" || ch === "\b") {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }

        // Ctrl-D mid-buffer, or any other control byte: ignore.
        if (isCtrlD) {
          continue;
        }

        buffer += ch;
        output.write("*");
      }
    }

    let buffer = "";
    input.on("data", onData);
  }).finally(() => {
    input.setRawMode(wasRaw);
    input.pause();
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

  // Providers with no route in the model registry (e.g. deepinfra today)
  // get no key/quota prompt — an existing stored key for them is kept as-is.
  const activeProviderNames = new Set(getActiveProviders(models));
  const activeProviderKeys = PROVIDER_KEYS.filter((provider) => activeProviderNames.has(provider.name));

  const existing = await readEnvFile();
  const next = { ...existing };
  const isRealTTY = Boolean(input.isTTY && output.isTTY);

  // On non-interactive stdin (a pipe that hits EOF), a pending rl.question()
  // never settles by itself — the interface just emits 'close' and the
  // process silently exits once the event loop drains, having written
  // nothing and shown no summary. Race every prompt against 'close' so EOF
  // turns into an explicit, visible "skip" for that prompt and every one
  // after it, instead of a silent early exit.
  let eofReached = false;
  async function askOrSkip(activeRl, promptFn) {
    if (eofReached) {
      return null;
    }
    const EOF = Symbol("eof");
    const closed = new Promise((resolve) => activeRl.once("close", () => resolve(EOF)));
    const answer = await Promise.race([promptFn(), closed]);
    if (answer === EOF) {
      eofReached = true;
      output.write(`\n${styles.dim("stdin closed — treating remaining prompts as skipped")}\n`);
      return null;
    }
    return answer;
  }

  // Key prompts hold a secret, so on a real TTY they use readSecret() (raw
  // mode, masked with '*'). A readline interface must NOT be alive at the
  // same time — it would compete with raw mode for stdin — so it's only
  // created here for the non-TTY fallback path (pipes, or Claude Code's `!`
  // passthrough), where the host terminal echoes input either way.
  let keyLoopRl = null;
  async function promptForKey(promptText) {
    if (eofReached) {
      return null;
    }
    if (isRealTTY) {
      const answer = await readSecret(promptText);
      if (answer === CTRL_C) {
        output.write(`${styles.dim("cancelled")}\n`);
        process.exit(130);
      }
      if (answer === null) {
        eofReached = true;
        output.write(`\n${styles.dim("stdin closed — treating remaining prompts as skipped")}\n`);
        return null;
      }
      return answer;
    }
    return askOrSkip(keyLoopRl, () => keyLoopRl.question(promptText));
  }

  try {
    output.write(`Writing keys to ${ENV_FILE}\n`);
    output.write(`Home: ${os.homedir()}\n\n`);

    if (!isRealTTY) {
      keyLoopRl = readline.createInterface({ input, output });
      output.write(
        `${styles.dim("note: this environment echoes what you type — for hidden input, run cc-delegate-keys in a regular terminal")}\n\n`,
      );
    }

    for (const [index, provider] of activeProviderKeys.entries()) {
      const current = existing[provider.envKey] || "";
      output.write(`${styles.bold(`[${index + 1}/${activeProviderKeys.length}] ${provider.name}`)}\n`);
      output.write(`  ${current ? styles.green(`stored ${maskKey(current)}`) : styles.dim("not stored")}\n`);
      const answer = await promptForKey("  paste key or press Enter to keep/skip: ");
      if (answer === null) {
        continue;
      }
      const trimmed = answer.trim();
      if (trimmed) {
        next[provider.envKey] = trimmed;
        output.write(`  ${styles.green("✓ saved")}\n`);
      }
      output.write("\n");
    }
  } finally {
    if (keyLoopRl) {
      keyLoopRl.close();
    }
  }

  await writeEnv(next);

  const config = await loadConfig();
  const configuredProviders = activeProviderKeys.filter((provider) => next[provider.envKey]);

  if (!eofReached && configuredProviders.length) {
    output.write(`${styles.bold("Monthly spend quotas (USD, optional)")}\n`);
    const rl2 = readline.createInterface({ input, output });
    try {
      for (const [index, provider] of configuredProviders.entries()) {
        const current = config.quotas[provider.name];
        output.write(`${styles.bold(`[${index + 1}/${configuredProviders.length}] ${provider.name}`)}\n`);
        output.write(
          `  ${current !== undefined ? `current $${current}` : styles.dim(`not set (default $${provider.defaultQuota})`)}\n`,
        );
        const answer = await askOrSkip(rl2, () =>
          rl2.question(`  monthly quota USD [Enter keeps current/default, "0" or "none" disables]: `),
        );
        if (answer === null) {
          break;
        }
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

  // Inactive providers (no route in the model registry) are hidden from the
  // summary unless they still carry a stored key — then they're shown with a
  // dim marker so the user knows why a key exists for a provider that isn't
  // being used.
  const summaryProviders = PROVIDER_KEYS.filter(
    (provider) => activeProviderNames.has(provider.name) || next[provider.envKey],
  );
  const nameWidth = Math.max(0, ...summaryProviders.map((provider) => provider.name.length));
  const summary = summaryProviders.map((provider) => {
    const value = next[provider.envKey] || "";
    const quota = config.quotas[provider.name];
    const keyMark = value ? styles.green("✓") : styles.dim("–");
    const quotaMark = value && quota !== undefined ? styles.green("✓") : styles.dim("–");
    const keyCol = value ? `key ${keyMark} ${maskKey(value)}` : `key ${keyMark} not configured`;
    const quotaCol =
      value && quota !== undefined ? `quota ${quotaMark} $${quota}/mo` : `quota ${quotaMark} disabled`;
    const inactiveNote = activeProviderNames.has(provider.name)
      ? ""
      : `  ${styles.dim("(inactive — no model routes)")}`;
    return `  ${provider.name.padEnd(nameWidth)}  ${padVisible(keyCol, 28)}  ${quotaCol}${inactiveNote}`;
  });

  output.write(`${styles.bold("Configured providers")}\n`);
  output.write(`${summary.join("\n")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
