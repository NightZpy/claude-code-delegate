import http from "node:http";
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs/promises";
import { unlinkSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { loadKeys } from "./env.mjs";

const execFileAsync = promisify(execFile);

const OPENCODE_SERVER_STATE_FILE = "opencode.json";
const OPENCODE_PORT = 4096;
const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_POLL_TIMEOUT_MS = 20000;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
const DEFAULT_MESSAGE_TIMEOUT_MS = 900000;

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

// Is a pid actually alive? kill(pid,0) throws ESRCH if the process is gone,
// EPERM if it exists but we can't signal it (still alive). Anything else / bad
// pid → treat as not-alive so a garbage lock can be reclaimed.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Read the agentic-slot lock. New format is JSON {pid, startedAt, jobId};
// tolerate the old bare-pid string. Returns null if absent/unreadable.
export async function readAgenticSlotHolder(stateDir) {
  const lockFile = path.join(stateDir, "agentic-run.lock");
  try {
    const raw = (await fs.readFile(lockFile, "utf8")).trim();
    if (!raw) return null;
    const holder = raw[0] === "{" ? JSON.parse(raw) : { pid: Number(raw) || null };
    return { ...holder, alive: pidAlive(holder.pid) };
  } catch {
    return null;
  }
}

// Free the agentic slot even on abnormal exit (OOM kill, SIGTERM, provider
// error that crashes the worker) — the normal releaseSlot() in `finally` is not
// enough, and a leaked lock used to deadlock every future agentic job. We track
// the lock files this process holds and remove them synchronously on exit/signal.
const _heldSlotLocks = new Set();
let _slotExitHandlersInstalled = false;
function installSlotExitHandlers() {
  if (_slotExitHandlersInstalled) return;
  _slotExitHandlersInstalled = true;
  const sweep = () => {
    for (const f of _heldSlotLocks) {
      try { unlinkSync(f); } catch {}
    }
  };
  process.on("exit", sweep);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => { sweep(); process.exit(1); });
  }
  process.on("uncaughtException", (err) => { sweep(); throw err; });
}

// A run-level lock held for a WHOLE agentic execution (server + session +
// message), not just the ensure phase. Two concurrent agentic jobs share one
// opencode server on a fixed port; without this the second job's ensure/session
// tears down the first's in-flight session and its next fetch fails. Serializes
// agentic runs instead. ponytail: one shared server, serialized — per-job ports
// would allow true parallelism if it ever matters.
export async function acquireAgenticSlot(stateDir, { onWait, jobId } = {}) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockFile = path.join(stateDir, "agentic-run.lock");
  const deadline = Date.now() + 45 * 60 * 1000; // long enough for a slow kimi run
  let warned = false;
  while (Date.now() < deadline) {
    try {
      const fh = await fs.open(lockFile, "wx");
      await fh.write(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), jobId: jobId || null }));
      await fh.close();
      _heldSlotLocks.add(lockFile);
      installSlotExitHandlers();
      return async () => {
        _heldSlotLocks.delete(lockFile);
        await fs.rm(lockFile, { force: true });
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err; // a real fs error, not "lock held"
      // Reclaim on LIVENESS, not wall-clock: a crashed holder (OOM, 402, kill)
      // leaves its pid but the process is dead — steal the slot immediately
      // instead of blocking every future agentic job for ~46 minutes.
      const holder = await readAgenticSlotHolder(stateDir);
      if (holder && Number.isInteger(holder.pid) && !holder.alive) {
        await fs.rm(lockFile, { force: true });
        continue; // retry now
      }
      // Fallback for a garbage/pid-less lock: reclaim if it's been sitting >2 min.
      if (!holder || !Number.isInteger(holder.pid)) {
        try {
          const st = await fs.stat(lockFile);
          if (Date.now() - st.mtimeMs > 2 * 60 * 1000) {
            await fs.rm(lockFile, { force: true });
            continue;
          }
        } catch {}
      }
      if (!warned && onWait) {
        warned = true;
        await onWait(holder || null);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("timed out waiting for the agentic run slot (another agentic job held it too long)");
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
      await stopServer(stateDir);
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

// Optionally pin the session to a specific directory (a git worktree) so its
// tools read/write there — this is what lets N sessions on ONE server run
// against N isolated worktrees concurrently, no per-session server needed.
export async function createSession(server, { directory } = {}) {
  const requestPath = directory ? `/session?directory=${encodeURIComponent(directory)}` : "/session";
  return ocFetch(server, "POST", requestPath, {});
}

export async function httpRequestJson({
  base,
  auth,
  method,
  path,
  body,
  timeoutMs,
}) {
  const url = new URL(path, base);
  const options = {
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname + url.search,
    method,
    headers: {
      authorization: auth,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const data = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const trimmed = data.slice(0, 400);
          reject(
            new Error(
              `OpenCode API ${method} ${path} returned ${res.statusCode}: ${trimmed}`,
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`OpenCode API ${method} ${path} returned unparseable JSON: ${data.slice(0, 400)}`));
        }
      });
      res.on("error", reject);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("__cc_timeout__"));
    });

    req.on("error", (err) => {
      if (err && String(err.message).includes("__cc_timeout__")) {
        reject(
          new Error(
            `model call exceeded ${Math.round(timeoutMs / 1000)}s (raise with --call-timeout)`,
          ),
        );
        return;
      }
      reject(err);
    });

    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

export async function sendMessage(
  server,
  sessionId,
  { text, agent, model, timeoutMs = DEFAULT_MESSAGE_TIMEOUT_MS },
) {
  const body = {
    parts: [{ type: "text", text }],
    model: { providerID: model.providerID, modelID: model.modelID },
  };
  if (agent) {
    body.agent = agent;
  }

  return httpRequestJson({
    base: server.base,
    auth: server.auth,
    method: "POST",
    path: `/session/${sessionId}/message`,
    body,
    timeoutMs,
  });
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

export async function listMessages(server, sessionId) {
  return ocFetch(server, "GET", `/session/${sessionId}/message`);
}

function toolPartToLine(part) {
  if (!part || typeof part !== "object") return null;
  const name = part.name;
  const args = part.arguments || part.args || {};
  if (!name) return null;
  const keyMap = {
    read: "filePath",
    edit: "filePath",
    write: "filePath",
    glob: "pattern",
    grep: "pattern",
    bash: "command",
    list: "directory",
  };
  const primaryKey = keyMap[name] || "filePath" || "path" || "command" || "pattern";
  let primaryValue = args[primaryKey];
  if (primaryValue === undefined || primaryValue === null) {
    // fallback: try any common keyword key
    for (const key of ["filePath", "path", "command", "pattern", "directory", "query", "search", "name"]) {
      if (args[key] !== undefined) {
        primaryValue = args[key];
        break;
      }
    }
  }
  let argStr = "";
  if (primaryValue != null) {
    argStr = typeof primaryValue === "string" ? primaryValue : JSON.stringify(primaryValue);
    if (argStr.length > 60) argStr = argStr.slice(0, 57) + "...";
  }
  return argStr ? `${name}: ${argStr}` : name;
}

export function summarizeActivity(messages) {
  if (!Array.isArray(messages)) return [];
  const lines = [];
  for (const msg of messages) {
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    for (const part of parts) {
      if (part && part.type === "tool") {
        const line = toolPartToLine(part);
        if (line) lines.push(line);
      }
    }
  }
  return lines.length <= 10 ? lines : lines.slice(-10);
}

// Sum cost + tokens across ALL assistant messages in a session. An agentic run
// is a tool loop: every read/bash/edit turn is a SEPARATE billed model call.
// The final message's info.cost is only the last turn — the real bill is the
// sum of every assistant turn. Under-counting this was a ~17x cost error.
export function sumSessionUsage(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let cost = 0, input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0, turns = 0;
  for (const m of list) {
    const info = m?.info || m || {};
    if (info.role !== "assistant") continue;
    turns += 1;
    cost += Number(info.cost || 0);
    const t = info.tokens || {};
    input += Number(t.input || 0);
    output += Number(t.output || 0);
    reasoning += Number(t.reasoning || 0);
    cacheRead += Number(t.cache?.read || 0);
    cacheWrite += Number(t.cache?.write || 0);
  }
  return { cost, input, output, reasoning, cacheRead, cacheWrite, turns };
}
