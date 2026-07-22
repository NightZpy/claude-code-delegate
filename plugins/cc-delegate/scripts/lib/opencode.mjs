import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadKeys } from "./env.mjs";

const execFileAsync = promisify(execFile);

const OPENCODE_SERVER_STATE_FILE = "opencode.json";
const OPENCODE_PORT = 4096;
const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_POLL_TIMEOUT_MS = 20000;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
const DEFAULT_MESSAGE_TIMEOUT_MS = 600000;

export async function isOpencodeInstalled() {
  try {
    await execFileAsync("opencode", ["--version"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export async function getOpencodeVersion() {
  try {
    const { stdout } = await execFileAsync("opencode", ["--version"], { windowsHide: true });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function makeBasicAuth(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

function serverStateFile(stateDir) {
  return path.join(stateDir, OPENCODE_SERVER_STATE_FILE);
}

export async function readServerState(stateDir) {
  try {
    const text = await fs.readFile(serverStateFile(stateDir), "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || !parsed.pid || !parsed.port || !parsed.password) {
      return null;
    }
    const port = Number(parsed.port);
    return {
      pid: Number(parsed.pid),
      port,
      password: String(parsed.password),
      base: `http://127.0.0.1:${port}`,
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    // ponytail: a corrupt state file is treated as "no server" — the next
    // ensureServer call simply spawns a fresh one.
    return null;
  }
}

async function writeServerState(stateDir, state) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  // The state file holds the server password — owner-only, like our .env.
  await fs.writeFile(
    serverStateFile(stateDir),
    `${JSON.stringify({ pid: state.pid, port: state.port, password: state.password }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.chmod(serverStateFile(stateDir), 0o600);
}

export async function checkServerHealth(server) {
  try {
    const response = await fetch(`${server.base}/global/health`, {
      headers: { authorization: server.auth },
      signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Reuses the persisted server (stateDir/opencode.json) when it still answers
// the health check; otherwise spawns a detached `opencode serve` with a fresh
// random Basic-auth password and all configured provider keys in its env.

// Lean delegate agents: same plan/build permission split but with a short
// system prompt — measured ~18% fewer input tokens per call than the stock
// opencode agents (the remaining ~11k tokens are tool schemas, inherent to
// agentic operation). Written once to the user-level opencode config.
const LEAN_AGENTS = {
  "cc-plan": `---
description: cc-delegate read-only executor (lean harness)
mode: primary
tools:
  read: true
  grep: true
  glob: true
  list: true
  write: false
  edit: false
  bash: false
---
You are a delegated software engineer with read-only access. Execute exactly the requested bounded task in this repository, then stop. Be direct: no plans, no summaries beyond the result.
`,
  "cc-build": `---
description: cc-delegate read-write executor (lean harness)
mode: primary
tools:
  read: true
  grep: true
  glob: true
  list: true
  write: true
  edit: true
  bash: true
---
You are a delegated software engineer. Execute exactly the requested bounded task in this repository, then stop. Be direct: no plans, no summaries beyond the result.
`,
};

// Ensure lean agents exist in the user-level opencode config. Returns true if
// any file was newly written (server restart needed to pick them up).
export async function ensureLeanAgents() {
  const agentDir = path.join(os.homedir(), ".config", "opencode", "agent");
  let wrote = false;
  try {
    await fs.mkdir(agentDir, { recursive: true });
    for (const [name, content] of Object.entries(LEAN_AGENTS)) {
      const file = path.join(agentDir, `${name}.md`);
      let current = null;
      try {
        current = await fs.readFile(file, "utf8");
      } catch {
        // missing
      }
      if (current !== content) {
        await fs.writeFile(file, content, "utf8");
        wrote = true;
      }
    }
  } catch {
    // ponytail: best-effort — stock plan/build agents remain the fallback.
  }
  return wrote;
}

async function acquireEnsureLock(stateDir) {
  const lockFile = path.join(stateDir, "opencode.lock");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const fh = await fs.open(lockFile, "wx");
      await fh.close();
      return lockFile;
    } catch {
      try {
        const st = await fs.stat(lockFile);
        if (Date.now() - st.mtimeMs > 30000) {
          await fs.rm(lockFile, { force: true }); // ponytail: stale lock steal
          continue;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error("timed out waiting for the opencode ensure lock");
}

export async function ensureServer(stateDir) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lock = await acquireEnsureLock(stateDir);
  try {
    return await ensureServerLocked(stateDir);
  } finally {
    await fs.rm(lock, { force: true });
  }
}

async function ensureServerLocked(stateDir) {
  const existing = await readServerState(stateDir);
  if (existing) {
    const server = { base: existing.base, auth: makeBasicAuth(existing.password) };
    if (await checkServerHealth(server)) {
      // Sessions inherit the server's cwd — a healthy server anchored to a
      // different directory must be recycled or the delegate works in the
      // wrong repo (single-workspace server: ponytail ceiling).
      if (existing.cwd && path.resolve(existing.cwd) === path.resolve(process.cwd())) {
        return server;
      }
      await stopServerLocked(stateDir, existing);
    } else {
    // Stale state: the recorded server is gone or wedged — kill the pid
    // (best effort) and respawn below.
    try {
      process.kill(existing.pid, "SIGTERM");
    } catch {
      // ponytail: already dead — nothing to clean up
    }
    }
  }

  // Refuse to adopt an opencode server we did not start: if the port answers
  // but we hold no state for it, a foreign/unmanaged instance is running —
  // its agents/env are unknown and our auth means nothing to it.
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), HEALTH_REQUEST_TIMEOUT_MS);
    const res = await fetch(`http://127.0.0.1:${OPENCODE_PORT}/global/health`, { signal: controller.signal });
    clearTimeout(t);
    if (res.ok || res.status === 401) {
      throw new Error(
        `port ${OPENCODE_PORT} is in use by an opencode server not managed by cc-delegate` +
          `${res.status === 401 ? " (password-protected — possibly a previous instance after a state purge)" : ""}` +
          ` — stop it (pkill -f 'opencode serve') and retry`,
      );
    }
  } catch (error) {
    if (String(error?.message || "").includes("not managed by cc-delegate")) throw error;
    // connection refused → port free, proceed
  }

  const password = crypto.randomBytes(24).toString("hex");
  const keys = await loadKeys();
  const providerKeys = Object.fromEntries(
    Object.entries(keys.values).filter(([, value]) => value),
  );
  const child = spawn("opencode", ["serve", "--port", String(OPENCODE_PORT)], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      ...providerKeys,
      OPENCODE_SERVER_PASSWORD: password,
    },
  });
  child.unref();

  const server = {
    base: `http://127.0.0.1:${OPENCODE_PORT}`,
    auth: makeBasicAuth(password),
  };
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await checkServerHealth(server)) {
      await writeServerState(stateDir, { pid: child.pid, port: OPENCODE_PORT, password, cwd: process.cwd() });
      return server;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }

  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    // ignored — the process may already be gone
  }
  throw new Error(`opencode server did not become healthy within ${HEALTH_POLL_TIMEOUT_MS / 1000}s`);
}

export async function ocFetch(server, method, requestPath, body, opts = {}) {
  const response = await fetch(`${server.base}${requestPath}`, {
    method,
    headers: {
      authorization: server.auth,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: opts.signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OpenCode API ${method} ${requestPath} returned ${response.status}: ${text.slice(0, 400)}`,
    );
  }
  return response.json();
}

export async function createSession(server) {
  return ocFetch(server, "POST", "/session", {});
}

export async function sendMessage(server, sessionId, { text, agent, model, timeoutMs = DEFAULT_MESSAGE_TIMEOUT_MS }) {
  const body = {
    parts: [{ type: "text", text }],
    // model MUST be an object — a plain string is rejected with BadRequest.
    model: { providerID: model.providerID, modelID: model.modelID },
  };
  if (agent) {
    body.agent = agent;
  }
  try {
    return await ocFetch(server, "POST", `/session/${sessionId}/message`, body, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`opencode message timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

async function stopServerLocked(stateDir, state) {
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {}
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(state.pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      break;
    }
  }
  await fs.rm(serverStateFile(stateDir), { force: true });
}

export async function stopServer(stateDir) {
  const state = await readServerState(stateDir);
  if (!state) {
    await fs.rm(serverStateFile(stateDir), { force: true });
    return false;
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    // already dead
  }
  // Wait for the process to actually exit BEFORE dropping state — a concurrent
  // ensureServer must never see "no state" while the old server still answers.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(state.pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      break;
    }
  }
  await fs.rm(serverStateFile(stateDir), { force: true });
  return true;
}

// Pulls the assistant text plus billing metadata out of a message response:
// text = concatenated parts of type "text"; tokens/cost/model come from info.
export function extractText(response) {
  const parts = Array.isArray(response?.parts) ? response.parts : [];
  const text = parts
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text || ""))
    .join("\n")
    .trim();
  const info = response?.info || {};
  const tokens = info.tokens || {};
  const input = Number(tokens.input || 0);
  const output = Number(tokens.output || 0);
  const reasoning = Number(tokens.reasoning || 0);
  const cacheRead = Number(tokens.cache?.read || 0);
  const cacheWrite = Number(tokens.cache?.write || 0);
  const toolCalls = parts.filter((part) => part.type !== "text").length;

  return {
    text,
    tokens: {
      input,
      output,
      reasoning,
      cache: { read: cacheRead, write: cacheWrite },
    },
    cost: Number(info.cost || 0),
    modelID: info.modelID || null,
    providerID: info.providerID || null,
    reasoningTokens: reasoning,
    cacheRead,
    cacheWrite,
    toolCalls,
  };
}

