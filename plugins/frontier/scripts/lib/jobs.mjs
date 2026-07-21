import { spawn } from "node:child_process";
import { appendJobLog, updateJob } from "./state.mjs";

function errorMessage(error) {
  if (!error) {
    return "unknown job error";
  }
  return error.message || String(error);
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
    await appendJobLog(cwd, jobId, `job failed: ${message}`);
    return failed;
  }
}

export function spawnBackgroundWorker(entrypoint, cwd, jobId) {
  const child = spawn(process.execPath, [entrypoint, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}
