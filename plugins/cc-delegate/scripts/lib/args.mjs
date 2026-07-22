import path from "node:path";

// Flags that never take a value; without this list, `task --background "prompt"`
// would swallow the prompt as the flag's value.
const BOOLEAN_FLAGS = new Set(["background", "diff", "json", "all", "details", "health", "guide", "static", "agentic", "write", "purge", "reset", "yes", "export", "adversarial", "help"]);

function coerceValue(value) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}

function assignFlag(flags, name, value) {
  if (flags[name] === undefined) {
    flags[name] = value;
    return;
  }

  if (Array.isArray(flags[name])) {
    flags[name].push(value);
    return;
  }

  flags[name] = [flags[name], value];
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  const flags = {};
  const positionals = [];
  let cwd = process.cwd();
  let command = null;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "-C" || token === "--cwd") {
      const next = args[index + 1];
      if (!next) {
        throw new Error(`${token} requires a value`);
      }
      cwd = path.resolve(next);
      index += 1;
      continue;
    }

    if (token.startsWith("--")) {
      const eqIndex = token.indexOf("=");
      if (eqIndex !== -1) {
        const name = token.slice(2, eqIndex);
        const rawValue = token.slice(eqIndex + 1);
        assignFlag(flags, name, coerceValue(rawValue));
        continue;
      }

      const name = token.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        assignFlag(flags, name, true);
        continue;
      }
      const next = args[index + 1];
      if (!next || next.startsWith("-")) {
        assignFlag(flags, name, true);
        continue;
      }
      assignFlag(flags, name, coerceValue(next));
      index += 1;
      continue;
    }

    if (token.startsWith("-") && token !== "-") {
      const short = token.slice(1);
      if (short.length !== 1) {
        throw new Error(`unsupported short flag ${token}`);
      }
      const next = args[index + 1];
      if (!next || next.startsWith("-")) {
        assignFlag(flags, short, true);
        continue;
      }
      assignFlag(flags, short, coerceValue(next));
      index += 1;
      continue;
    }

    if (!command) {
      command = token;
      continue;
    }

    positionals.push(token);
  }

  return {
    command,
    cwd,
    flags,
    positionals,
  };
}
