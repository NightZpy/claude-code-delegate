import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INDEX_VERSION = 1;
const MAX_JOBS = 50;
const OWNER = "cc-delegate-companion";

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
}

export function createJobId() {
  const random = crypto.randomBytes(4).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, 6);
  return `task-${Date.now().toString(36)}-${random}`;
}

export async function resolveWorkspaceRoot(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      windowsHide: true,
    });
    const root = stdout.trim();
    return root || cwd;
  } catch {
    return cwd;
  }
}

// The plugin's own home — the SAME path whether the runtime is invoked from
// Claude Code or from the user's terminal.
const CC_DELEGATE_STATE_HOME = path.join(
  process.env.CC_DELEGATE_HOME || path.join(os.homedir(), ".claude", "cc-delegate"),
  "state",
);

export async function getWorkspaceState(cwd) {
  const workspaceRoot = await resolveWorkspaceRoot(cwd);
  const hash = crypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  const baseName = slugify(path.basename(workspaceRoot));
  const dirName = `${baseName}-${hash}`;

  // State location MUST be deterministic. It used to key off CLAUDE_PLUGIN_DATA,
  // which is only set inside Claude Code (and points at whichever plugin's data
  // dir) — so jobs dispatched by Claude Code landed somewhere the user's own
  // terminal never looked, and `jobs`/`status`/`watch` showed "no jobs yet".
  const legacyRoots = [];
  if (process.env.CLAUDE_PLUGIN_DATA) {
    legacyRoots.push(path.join(process.env.CLAUDE_PLUGIN_DATA, "state"));
  }
  legacyRoots.push(path.join(os.tmpdir(), "cc-delegate-companion"));

  const candidates = [CC_DELEGATE_STATE_HOME, ...legacyRoots];

  for (const stateRoot of candidates) {
    const workspaceDir = path.join(stateRoot, dirName);
    const jobsDir = path.join(workspaceDir, "jobs");

    try {
      // One-time adoption: if this workspace still lives under a legacy root,
      // move it into the deterministic home so existing history and in-flight
      // jobs stay visible from both contexts instead of being stranded.
      if (stateRoot === CC_DELEGATE_STATE_HOME) {
        let exists = true;
        try {
          await fs.access(workspaceDir);
        } catch {
          exists = false;
        }
        if (!exists) {
          for (const legacyRoot of legacyRoots) {
            const legacyDir = path.join(legacyRoot, dirName);
            try {
              await fs.access(legacyDir);
              await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
              await fs.rename(legacyDir, workspaceDir);
              break;
            } catch {
              // not there, or not movable — fall through to a fresh dir
            }
          }
        }
      }

      await fs.mkdir(jobsDir, { recursive: true });
      await fs.access(workspaceDir, fsConstants.W_OK);
      return {
        workspaceRoot,
        stateRoot,
        workspaceDir,
        indexFile: path.join(workspaceDir, "state.json"),
        jobsDir,
      };
    } catch (error) {
      if (error && ["EACCES", "EPERM", "EROFS"].includes(error.code)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("unable to initialize a writable state directory");
}

async function ensureWorkspaceDirs(cwd) {
  return getWorkspaceState(cwd);
}

async function readJson(file, fallback) {
  try {
    const text = await fs.readFile(file, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function summarizeJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt ?? null,
    cancelledAt: job.cancelledAt ?? null,
    pid: job.pid ?? null,
    model: job.model,
    provider: job.provider ?? null,
    promptPreview: job.promptPreview,
    error: job.error ?? null,
    tokens: job.usage ?? null,
    cost: job.cost ?? null,
  };
}

async function pruneIndex(workspace, index) {
  const sorted = [...index.jobs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const keep = sorted.slice(0, MAX_JOBS);
  const prune = sorted.slice(MAX_JOBS);
  const keepIds = new Set(keep.map((job) => job.id));

  for (const job of prune) {
    await fs.rm(path.join(workspace.jobsDir, `${job.id}.json`), { force: true });
    await fs.rm(path.join(workspace.jobsDir, `${job.id}.log`), { force: true });
  }

  index.jobs = index.jobs.filter((job) => keepIds.has(job.id));
  return index;
}

export async function readIndex(cwd) {
  const workspace = await ensureWorkspaceDirs(cwd);
  const index = await readJson(workspace.indexFile, {
    owner: OWNER,
    version: INDEX_VERSION,
    jobs: [],
  });
  if (index.owner && index.owner !== OWNER) {
    return {
      workspace,
      index: {
        owner: OWNER,
        version: INDEX_VERSION,
        jobs: [],
      },
    };
  }
  if (!index.owner) {
    return {
      workspace,
      index: {
        owner: OWNER,
        version: INDEX_VERSION,
        jobs: [],
      },
    };
  }
  if (index.version !== INDEX_VERSION) {
    index.version = INDEX_VERSION;
  }
  return { workspace, index };
}

export async function writeIndex(cwd, index) {
  const workspace = await ensureWorkspaceDirs(cwd);
  const next = await pruneIndex(workspace, index);
  await writeJson(workspace.indexFile, next);
}

export async function jobLogFilePath(cwd, jobId) {
  const workspace = await ensureWorkspaceDirs(cwd);
  return path.join(workspace.jobsDir, `${jobId}.log`);
}

export async function appendJobLog(cwd, jobId, message) {
  const workspace = await ensureWorkspaceDirs(cwd);
  const line = `[${new Date().toISOString()}] ${message}\n`;
  await fs.appendFile(path.join(workspace.jobsDir, `${jobId}.log`), line, "utf8");
}

export async function readJobLogTail(cwd, jobId, limit = 5) {
  const workspace = await ensureWorkspaceDirs(cwd);
  try {
    const text = await fs.readFile(path.join(workspace.jobsDir, `${jobId}.log`), "utf8");
    return text.trim().split(/\r?\n/).filter(Boolean).slice(-limit);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function createJob(cwd, data) {
  const workspace = await ensureWorkspaceDirs(cwd);
  const { index } = await readIndex(cwd);
  const now = new Date().toISOString();
  const job = {
    id: data.id ?? createJobId(),
    status: data.status ?? "queued",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    cancelledAt: null,
    pid: null,
    cwd: data.cwd,
    workspaceRoot: workspace.workspaceRoot,
    command: data.command ?? "task",
    model: data.model,
    provider: data.provider ?? null,
    promptPreview: data.promptPreview ?? "",
    request: data.request ?? null,
    resumedFrom: data.resumedFrom ?? null,
    result: null,
    error: null,
    usage: null,
    cost: null,
    attempts: [],
  };
  await writeJson(path.join(workspace.jobsDir, `${job.id}.json`), job);
  index.jobs = [summarizeJob(job), ...index.jobs.filter((entry) => entry.id !== job.id)];
  await writeIndex(cwd, index);
  await appendJobLog(cwd, job.id, `job created with status ${job.status}`);
  return job;
}

export async function loadJob(cwd, jobId) {
  const workspace = await ensureWorkspaceDirs(cwd);
  return readJson(path.join(workspace.jobsDir, `${jobId}.json`), null);
}

export async function updateJob(cwd, jobId, patch) {
  const current = await loadJob(cwd, jobId);
  if (!current) {
    throw new Error(`job ${jobId} not found`);
  }

  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  if (next.status === "completed" && !next.completedAt) {
    next.completedAt = next.updatedAt;
  }
  if (next.status === "cancelled" && !next.cancelledAt) {
    next.cancelledAt = next.updatedAt;
  }

  const { workspace, index } = await readIndex(cwd);
  await writeJson(path.join(workspace.jobsDir, `${jobId}.json`), next);
  index.jobs = [summarizeJob(next), ...index.jobs.filter((entry) => entry.id !== jobId)];
  await writeIndex(cwd, index);
  return next;
}

export async function listJobs(cwd) {
  const { index } = await readIndex(cwd);
  return [...index.jobs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function findJob(cwd, jobId) {
  if (jobId) {
    return loadJob(cwd, jobId);
  }
  const jobs = await listJobs(cwd);
  const latest = jobs[0];
  if (!latest) {
    return null;
  }
  return loadJob(cwd, latest.id);
}

export async function findLatestFinishedJob(cwd) {
  const jobs = await listJobs(cwd);
  const latest = jobs.find((job) => ["completed", "failed", "cancelled"].includes(job.status));
  if (!latest) {
    return null;
  }
  return loadJob(cwd, latest.id);
}

/**
 * Look up a job by id across ALL workspaces. Returns the first hit with
 * its resolved {@link jobsDir} and {@link jobPath}. Read-only — never
 * writes or moves files.
 *
 * Fast path: checks the current workspace first.
 * Fallback: scans sibling workspace dirs under CC_DELEGATE_STATE_HOME.
 *
 * @param {string} cwd - used to identify the "current" workspace
 * @param {string} jobId
 * @returns {Promise<{job: object, jobsDir: string, jobPath: string} | null>}
 */
export async function loadJobAnywhere(cwd, jobId) {
  // Basic traversal guard — reject paths that try to escape the jobs dir
  if (/[\/\\]/.test(jobId) || jobId.includes("..")) {
    return null;
  }
  // Fast path: current workspace
  const currentJob = await loadJob(cwd, jobId);
  if (currentJob) {
    const workspace = await getWorkspaceState(cwd);
    return {
      job: currentJob,
      jobsDir: workspace.jobsDir,
      jobPath: path.join(workspace.jobsDir, `${jobId}.json`),
    };
  }

  // Resolve the current workspace dir name so we can skip it
  let currentDirName;
  try {
    const ws = await getWorkspaceState(cwd);
    currentDirName = path.basename(ws.workspaceDir);
  } catch {
    currentDirName = null;
  }

  // Scan sibling workspace dirs
  let entries;
  try {
    entries = await fs.readdir(CC_DELEGATE_STATE_HOME, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (currentDirName && entry.name === currentDirName) continue;

    const candidatePath = path.join(CC_DELEGATE_STATE_HOME, entry.name, "jobs", `${jobId}.json`);
    const job = await readJson(candidatePath, null);
    if (job) {
      return {
        job,
        jobsDir: path.join(CC_DELEGATE_STATE_HOME, entry.name, "jobs"),
        jobPath: candidatePath,
      };
    }
  }

  return null;
}

// Is a pid actually alive? kill(pid,0) throws ESRCH if the process is gone,
// EPERM if it exists but we can't signal it (still alive).
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

const STALE_QUEUED_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Scan job files under a workspace's jobs dir. Returns job objects
 * augmented with jobPath and computed elapsedMs / ageMs.
 */
async function scanWorkspaceJobs(stateHome, entryName) {
  const jobsDir = path.join(stateHome, entryName, "jobs");
  let jobFiles;
  try {
    jobFiles = await fs.readdir(jobsDir);
  } catch {
    return [];
  }

  const reads = jobFiles
    .filter((file) => file.endsWith(".json"))
    .map(async (file) => {
      try {
        const job = await readJson(path.join(jobsDir, file), null);
        if (!job) return null;
        if (job.status !== "running" && job.status !== "queued") return null;
        const createdAtMs = Date.parse(job.createdAt);
        const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, Date.now() - createdAtMs) : 0;
        return { ...job, ageMs, elapsedMs: ageMs, jobPath: path.join(jobsDir, file) };
      } catch {
        return null;
      }
    });

  return (await Promise.all(reads)).filter(Boolean);
}

function classifyJob(job) {
  const { status, pid, ageMs } = job;
  if (status === "running") {
    return pidAlive(pid) ? "LIVE" : "STALE";
  }
  // status === "queued"
  if (pidAlive(pid)) return "LIVE"; // queued but already spawned with a live pid
  if (ageMs < STALE_QUEUED_AGE_MS) return "LIVE"; // legitimately pending
  return "STALE";
}

/**
 * Single-pass classifier: scans every workspace under CC_DELEGATE_STATE_HOME
 * once and splits jobs into LIVE and STALE. The two public exports
 * ({@link listRunningJobsAnywhere}, {@link listStaleJobsAnywhere}) delegate
 * to this so callers that need both avoid a double sweep.
 *
 * @returns {Promise<{ running: Array<object>, stale: Array<object> }>}
 */
export async function scanAndClassifyAllWorkspaces() {
  let entries;
  try {
    entries = await fs.readdir(CC_DELEGATE_STATE_HOME, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { running: [], stale: [] };
    }
    throw error;
  }

  const scans = [];
  const running = [];
  const stale = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    scans.push(
      scanWorkspaceJobs(CC_DELEGATE_STATE_HOME, entry.name).then((jobs) => {
        for (const job of jobs) {
          if (classifyJob(job) === "LIVE") {
            running.push(job);
          } else {
            stale.push({
              id: job.id,
              model: job.model,
              mode: job.mode || null,
              ageMs: job.ageMs,
              elapsedMs: job.elapsedMs,
              pid: job.pid,
              status: job.status,
              jobPath: job.jobPath,
            });
          }
        }
      }),
    );
  }
  await Promise.all(scans);

  running.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  stale.sort((a, b) => b.ageMs - a.ageMs);
  return { running: running.slice(0, 50), stale };
}

/**
 * List LIVE running/queued jobs across ALL workspaces. Returns up to 50 jobs,
 * sorted by createdAt descending. Each job includes a computed
 * {@code elapsedMs} field. Best-effort — skips unreadable files silently.
 *
 * @returns {Promise<Array<object>>}
 */
export async function listRunningJobsAnywhere() {
  const { running } = await scanAndClassifyAllWorkspaces();
  return running;
}

/**
 * List STALE jobs across all workspaces — jobs that appear running/queued but
 * whose worker process is dead (or queued with no live pid older than the
 * threshold). Each entry includes id, model, mode, ageMs/elapsedMs, pid,
 * status, and workspace jobPath so that {@link reapCommand} can rewrite them.
 *
 * @returns {Promise<Array<object>>}
 */
export async function listStaleJobsAnywhere() {
  const { stale } = await scanAndClassifyAllWorkspaces();
  return stale;
}

/**
 * Reap a single job at the given jobPath. Writes the job file AND updates
 * its workspace index. Guards against clobbering a concurrent transition:
 * skips the write if the job is no longer stale (terminal status or live pid).
 *
 * @param {string} jobPath - absolute path to <id>.json
 * @returns {Promise<{ reaped: boolean, reason?: string, job?: object }>}
 */
export async function reapJobAtPath(jobPath) {
  const workspaceDir = path.dirname(path.dirname(jobPath));
  const indexFile = path.join(workspaceDir, "state.json");

  // Re-read current job to guard against concurrent transitions
  const current = await readJson(jobPath, null);
  if (!current) {
    return { reaped: false, reason: "job file not found" };
  }

  // FIX 2: only reap if STILL stale — skip if terminal or pid is now alive
  const isTerminal = ["completed", "failed", "cancelled"].includes(current.status);
  if (isTerminal) {
    return { reaped: false, reason: "no longer stale" };
  }
  if (current.status === "running" && pidAlive(current.pid)) {
    return { reaped: false, reason: "no longer stale" };
  }
  if (current.status === "queued" && pidAlive(current.pid)) {
    return { reaped: false, reason: "no longer stale" };
  }
  // queued with dead pid is still stale (check against the age was done at scan time)

  const now = new Date().toISOString();
  const next = {
    ...current,
    status: "failed",
    pid: null,
    error: "reaped — worker process no longer alive",
    updatedAt: now,
  };
  if (!next.completedAt) next.completedAt = now;

  // Write job file
  await writeJson(jobPath, next);

  // Update workspace index
  const index = await readJson(indexFile, { owner: OWNER, version: INDEX_VERSION, jobs: [] });
  index.jobs = [summarizeJob(next), ...index.jobs.filter((entry) => entry.id !== next.id)];
  await writeJson(indexFile, index);

  return { reaped: true, job: next };
}
