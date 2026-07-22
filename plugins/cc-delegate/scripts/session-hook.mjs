import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readIndex, loadJob, updateJob } from "./lib/state.mjs";

async function scanForOrphans() {
  const stateRoots = [];
  if (process.env.CLAUDE_PLUGIN_DATA) {
    stateRoots.push(path.join(process.env.CLAUDE_PLUGIN_DATA, "state"));
  }
  stateRoots.push(path.join(os.tmpdir(), "cc-delegate-companion"));

  for (const stateRoot of stateRoots) {
    try {
      const entries = await fs.readdir(stateRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const workspaceDir = path.join(stateRoot, entry.name);
        const jobsDir = path.join(workspaceDir, "jobs");
        let jobsList;
        try {
          jobsList = await fs.readdir(jobsDir);
        } catch {
          continue;
        }
        for (const file of jobsList) {
          if (!file.endsWith(".json")) continue;
          const jobId = file.slice(0, -5);
          let job;
          try {
            job = await loadJob(jobsDir, jobId);
          } catch {
            continue;
          }
          if (!job || !job.pid || (job.status !== "running" && job.status !== "queued")) {
            continue;
          }
          try {
            process.kill(job.pid, 0);
          } catch {
            try {
              const cwd = job.cwd || process.cwd();
              await updateJob(cwd, jobId, {
                status: "failed",
                error: "orphaned: claude session ended",
                completedAt: new Date().toISOString(),
              });
            } catch {
              // continue sweeping
            }
          }
        }
      }
    } catch {
      continue;
    }
  }
}

async function main() {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) {
    return;
  }

  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }

  const payload = text.trim() ? JSON.parse(text) : {};
  const hookEventName = payload?.hook_event_name;
  const sessionId = payload?.session_id;

  if (hookEventName === "SessionEnd") {
    await scanForOrphans();
    return;
  }

  if (!sessionId) {
    return;
  }

  await fs.appendFile(envFile, `\nCC_DELEGATE_SESSION_ID=${sessionId}\n`, "utf8");
}

main().catch(() => {
  process.exitCode = 0;
});
