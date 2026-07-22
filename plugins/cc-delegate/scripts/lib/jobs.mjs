import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ENV_FILE, USAGE_LEDGER_FILE } from "./env.mjs";
import { appendJobLog, updateJob } from "./state.mjs";

function errorMessage(error) {
  if (!error) {
    return "unknown job error";
  }
  return error.message || String(error);
}

async function appendUsageLedger(job) {
  const promptTokens = Number(job?.usage?.prompt_tokens || 0);
  const completionTokens = Number(job?.usage?.completion_tokens || 0);
  const isCompleted = job.status === "completed";
  const attemptsList = Array.isArray(job?.attempts) ? job.attempts : [];
  const failedProviders = attemptsList
    .filter((attempt) => attempt.outcome === "error")
    .map((attempt) => attempt.provider);
  const attempts = attemptsList.filter(
    (attempt) => attempt.outcome === "error" || attempt.outcome === "success",
  ).length;

  if (isCompleted) {
    if (!promptTokens && !completionTokens) {
      return;
    }
  } else if (!failedProviders.length && !job.contextExceeded) {
    // every provider was skipped for a missing key — that's config, not a health
    // signal. Context-guard failures (contextExceeded) DO get recorded.
    return;
  }

  const row = {
    ts: new Date().toISOString(),
    workspace: job.workspaceRoot || job.cwd || process.cwd(),
    jobId: job.id,
    sessionId: process.env.CC_DELEGATE_SESSION_ID || null,
    model: job.result?.alias || job.model || null,
    modelId: job.result?.modelId || null,
    provider: job.result?.provider || job.provider || null,
    promptTokens,
    completionTokens,
    cost: Number(job.cost || 0),
    status: isCompleted ? "completed" : "failed",
    latencyMs: isCompleted ? (job.latencyMs ?? null) : null,
    attempts: attempts || 1,
    failedProviders,
    ctxPct: job.ctxPct ?? null,
    // Additive: agentic rows carry mode:"agentic"; text-mode rows (and all
    // historical rows) have no field at all, which readers treat as "text".
    ...(job.mode ? { mode: job.mode } : {}),
  };

  try {
    await fs.mkdir(path.dirname(ENV_FILE), { recursive: true });
    await fs.appendFile(USAGE_LEDGER_FILE, `${JSON.stringify(row)}\n`, "utf8");
  } catch {
    // ponytail: ledger write failures must never fail the delegated task
  }
}

export async function runTrackedJob(cwd, jobId, runner) {
  await updateJob(cwd, jobId, {
    status: "running",
    pid: process.pid,
    error: null,
  });
  await appendJobLog(cwd, jobId, `job running with pid ${process.pid}`);

  try {
    const outcome = await runner({
      log: async (message) => appendJobLog(cwd, jobId, message),
      setJob: async (patch) => updateJob(cwd, jobId, patch),
    });

    const completed = await updateJob(cwd, jobId, {
      status: "completed",
      pid: null,
      ...outcome,
    });
    await appendUsageLedger(completed);
    const finalPreview = completed.result?.content?.slice(0, 400) ?? "(empty result)";
    await appendJobLog(cwd, jobId, `job completed: ${finalPreview}`);
    return completed;
  } catch (error) {
    const message = errorMessage(error);
    const failed = await updateJob(cwd, jobId, {
      status: "failed",
      pid: null,
      error: message,
    });
    await appendUsageLedger(failed);
    await appendJobLog(cwd, jobId, `job failed: ${message}`);
    return failed;
  }
}

export function spawnBackgroundWorker(entrypoint, cwd, jobId) {
  const child = spawn(process.execPath, [entrypoint, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}
