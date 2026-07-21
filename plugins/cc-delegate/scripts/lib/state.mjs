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

export async function getWorkspaceState(cwd) {
  const workspaceRoot = await resolveWorkspaceRoot(cwd);
  const hash = crypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  const baseName = slugify(path.basename(workspaceRoot));
  const stateRoots = [];
  if (process.env.CLAUDE_PLUGIN_DATA) {
    stateRoots.push(path.join(process.env.CLAUDE_PLUGIN_DATA, "state"));
  }
  stateRoots.push(path.join(os.tmpdir(), "cc-delegate-companion"));

  for (const stateRoot of stateRoots) {
    const workspaceDir = path.join(stateRoot, `${baseName}-${hash}`);
    const jobsDir = path.join(workspaceDir, "jobs");

    try {
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
