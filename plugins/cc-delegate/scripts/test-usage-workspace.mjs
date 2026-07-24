// Must be set BEFORE any lib/ imports — they read it at module init time.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(__dirname, "companion.mjs");

// Isolate the entire state tree in a temp dir so we never touch the real
// ~/.claude/cc-delegate/state. Set BEFORE importing lib/*.mjs.
const TEMP_HOME = path.join(os.tmpdir(), `cc-delegate-test-${Date.now()}`);
await fs.mkdir(TEMP_HOME, { recursive: true });
process.env.CC_DELEGATE_HOME = TEMP_HOME;

const CC_DELEGATE_STATE_HOME = path.join(TEMP_HOME, "state");

// Now safe to import lib modules — they'll see the overridden CC_DELEGATE_HOME
const { getWorkspaceState, loadJobAnywhere, listRunningJobsAnywhere, listStaleJobsAnywhere, reapJobAtPath } = await import("./lib/state.mjs");
const { CC_DELEGATE_HOME } = await import("./lib/env.mjs");

// Helper to spawn and wait for CLI command — passes CC_DELEGATE_HOME env
async function runCli(args, cwd = process.cwd(), timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [COMPANION, "-C", cwd, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CC_DELEGATE_HOME: TEMP_HOME },
    });

    let stdout = "";
    let stderr = "";
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        proc.kill("SIGKILL");
        reject(new Error(`HANG: process did not exit within ${timeoutMs}ms`));
      }
    }, timeoutMs);

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      }
    });

    proc.on("error", (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

// Deterministic workspace dir name matching getWorkspaceState internals
function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

function workspaceDirName(workspaceRoot) {
  const hash = crypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return `${slugify(path.basename(workspaceRoot))}-${hash}`;
}

// Synthetic workspaces we create — tracked for cleanup
const cleanupDirs = [TEMP_HOME];

async function createSyntheticWorkspace(root, jobData) {
  const dirName = workspaceDirName(root);
  const workspaceDir = path.join(CC_DELEGATE_STATE_HOME, dirName);
  const jobsDir = path.join(workspaceDir, "jobs");

  await fs.mkdir(jobsDir, { recursive: true });

  const jobId = jobData.id || `test-job-${Date.now()}`;
  const job = {
    id: jobId,
    ...jobData,
    createdAt: jobData.createdAt || new Date().toISOString(),
    updatedAt: jobData.updatedAt || new Date().toISOString(),
  };
  const jobPath = path.join(jobsDir, `${jobId}.json`);
  await fs.writeFile(jobPath, JSON.stringify(job, null, 2));

  return { jobId, jobPath, jobsDir, workspaceDir, job };
}

async function cleanup() {
  // Remove the entire temp home (not just workspace dirs)
  await fs.rm(TEMP_HOME, { recursive: true, force: true });
}

async function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function runTests() {
  console.log("Test: cc-delegate cross-workspace lookup + usage/in-flight + stale/reap\n");
  console.log(`  (isolated: ${TEMP_HOME})`);

  const unrelatedCwd = os.homedir(); // a cwd that is NOT any synthetic workspace

  // ─── 1. Cross-workspace lookup ───────────────────────────────────────
  console.log("\n--- Test 1: cross-workspace lookup ---");

  const ws1Root = path.join(os.tmpdir(), "cc-delegate-xws-test-1", ".git");
  await fs.mkdir(ws1Root, { recursive: true });
  const completedJobId = `task-xws-completed-${Date.now()}`;
  const { jobId: cJobId, jobPath: cJobPath } = await createSyntheticWorkspace(
    ws1Root,
    {
      id: completedJobId,
      status: "completed",
      model: "test-model",
      provider: "test-provider",
      completedAt: new Date().toISOString(),
      result: { content: "cross-workspace test result" },
      cost: 0.001,
    },
  );

  // Verify loadJobAnywhere finds the completed job from an unrelated cwd
  const resolved = await loadJobAnywhere(unrelatedCwd, cJobId);
  assert(resolved !== null, "loadJobAnywhere should find job in other workspace");
  assert(resolved.job.id === cJobId, "resolved job should match id");
  assert(resolved.job.status === "completed", "resolved job should be completed");
  assert(resolved.jobPath === cJobPath, "resolved jobPath should match");
  console.log("  ✓ loadJobAnywhere finds job in other workspace");

  // Verify await --json finds the job from an unrelated cwd and exits 0
  const awaitResult = await runCli(["await", cJobId, "--json"], unrelatedCwd);
  assert(
    awaitResult.code === 0,
    `await should exit 0 for completed job in other workspace, got ${awaitResult.code}\nstderr: ${awaitResult.stderr}`,
  );
  const awaitPayload = JSON.parse(awaitResult.stdout);
  assert(awaitPayload.jobId === cJobId, "await payload should have correct jobId");
  assert(awaitPayload.status === "completed", "await payload should show completed");
  assert(!awaitResult.stderr.includes("not found"), "stderr should not contain 'not found'");
  console.log("  ✓ await finds and returns completed job in other workspace (exit 0)");

  // ─── 2. In-flight listing ────────────────────────────────────────────
  console.log("\n--- Test 2: in-flight listing ---");

  const ws2Root = path.join(os.tmpdir(), "cc-delegate-xws-test-2");
  await fs.mkdir(ws2Root, { recursive: true });
  const runningJobId = `task-xws-running-${Date.now()}`;
  const { jobId: rJobId } = await createSyntheticWorkspace(ws2Root, {
    id: runningJobId,
    status: "running",
    model: "test-running-model",
    provider: "test-provider",
    mode: "text",
    pid: process.pid, // LIVE pid so it counts as running (not stale)
  });

  // Verify listRunningJobsAnywhere includes the running job (its pid is alive)
  const running = await listRunningJobsAnywhere();
  const foundRunning = running.find((j) => j.id === rJobId);
  assert(foundRunning !== undefined, "listRunningJobsAnywhere should include the live running job");
  assert(foundRunning.status === "running", "found job should be running");
  assert(typeof foundRunning.elapsedMs === "number", "elapsedMs should be a number");
  assert(foundRunning.elapsedMs >= 0, "elapsedMs should be non-negative");
  console.log("  ✓ listRunningJobsAnywhere includes live running job with elapsedMs");

  // Verify usage --details --json has inFlight key and NOT in entries
  const detailsResult = await runCli(["usage", "--details", "--json"], unrelatedCwd);
  assert(detailsResult.code === 0, `usage --details --json should exit 0, got ${detailsResult.code}`);
  const detailsPayload = JSON.parse(detailsResult.stdout);
  assert("inFlight" in detailsPayload, "usage --details --json should have inFlight key");
  assert(Array.isArray(detailsPayload.inFlight), "inFlight should be an array");
  assert("entries" in detailsPayload, "usage --details --json should have entries key");
  assert(Array.isArray(detailsPayload.entries), "entries should be an array");
  assert("stale" in detailsPayload, "usage --details --json should have stale key");
  assert(Array.isArray(detailsPayload.stale), "stale should be an array");

  const inFlightRunning = detailsPayload.inFlight.find((j) => j.jobId === rJobId);
  assert(inFlightRunning !== undefined, "inFlight should contain the live running job");
  assert(inFlightRunning.status === "running", "in-flight job should be running");
  assert(inFlightRunning.model === "test-running-model", "in-flight model should match");

  // Verify running job is NOT in the ledger entries
  const inEntries = detailsPayload.entries.some((e) => e.jobId === rJobId);
  assert(!inEntries, "running job should NOT appear in ledger entries");
  console.log("  ✓ usage --details --json has inFlight with running job, separate from entries");

  // Verify usage summary prints running: line
  const summaryResult = await runCli(["usage", "--static"], unrelatedCwd);
  assert(summaryResult.code === 0, `usage should exit 0, got ${summaryResult.code}`);
  assert(
    /running:\s*\d+/.test(summaryResult.stdout),
    `usage summary should have 'running: N' line\nstdout: ${summaryResult.stdout}`,
  );
  const runningMatch = summaryResult.stdout.match(/running:\s*(\d+)/);
  const runningCount = parseInt(runningMatch[1], 10);
  assert(runningCount >= 1, `running count should be >= 1, got ${runningCount}`);
  console.log("  ✓ usage summary prints 'running: N' line with count >= 1");

  // ─── 3. Stale job classification ────────────────────────────────────
  console.log("\n--- Test 3: stale job classification ---");

  const ws3Root = path.join(os.tmpdir(), "cc-delegate-xws-test-3");
  await fs.mkdir(ws3Root, { recursive: true });
  const staleJobId = `task-xws-stale-${Date.now()}`;
  const { jobId: sJobId, jobPath: sJobPath } = await createSyntheticWorkspace(ws3Root, {
    id: staleJobId,
    status: "running",
    model: "stale-model",
    provider: "test-provider",
    mode: "agentic",
    pid: 99999, // definitely dead pid
  });

  // Must NOT appear in listRunningJobsAnywhere (dead pid)
  const runningAfterStale = await listRunningJobsAnywhere();
  assert(
    !runningAfterStale.some((j) => j.id === sJobId),
    "stale job with dead pid should NOT appear in listRunningJobsAnywhere",
  );
  console.log("  ✓ stale job excluded from listRunningJobsAnywhere");

  // Must appear in listStaleJobsAnywhere
  const stale = await listStaleJobsAnywhere();
  const foundStale = stale.find((j) => j.id === sJobId);
  assert(foundStale !== undefined, "stale job should appear in listStaleJobsAnywhere");
  assert(foundStale.status === "running", "stale job should have status running");
  assert(foundStale.pid === 99999, "stale job should report pid 99999");
  assert(typeof foundStale.ageMs === "number" && foundStale.ageMs >= 0, "ageMs should be non-negative");
  assert(typeof foundStale.jobPath === "string", "stale job should have jobPath");
  console.log("  ✓ stale job appears in listStaleJobsAnywhere with ageMs and jobPath");

  // must NOT appear in inFlight of usage --details --json
  const details2 = await runCli(["usage", "--details", "--json"], unrelatedCwd);
  const details2Payload = JSON.parse(details2.stdout);
  assert(
    !details2Payload.inFlight.some((j) => j.jobId === sJobId),
    "stale job should NOT appear in inFlight",
  );
  // must appear in stale array
  assert(
    details2Payload.stale.some((j) => j.jobId === sJobId),
    "stale job should appear in usage --details --json stale array",
  );
  console.log("  ✓ stale job in usage --details --json stale, not inFlight");

  // ─── 4. Reap command ─────────────────────────────────────────────────
  console.log("\n--- Test 4: reap command ---");

  // Dry-run --json
  const dryRunResult = await runCli(["reap", "--dry-run", "--json"], unrelatedCwd);
  assert(dryRunResult.code === 0, `reap --dry-run --json should exit 0, got ${dryRunResult.code}`);
  const dryRunPayload = JSON.parse(dryRunResult.stdout);
  assert("wouldReap" in dryRunPayload, "dry-run json should have wouldReap");
  assert(Array.isArray(dryRunPayload.wouldReap), "wouldReap should be an array");
  assert(dryRunPayload.count >= 1, `wouldReap count should be >= 1, got ${dryRunPayload.count}`);
  const wouldReapStale = dryRunPayload.wouldReap.find((j) => j.jobId === sJobId);
  assert(wouldReapStale !== undefined, "wouldReap should include the stale job");
  assert(wouldReapStale.pid === 99999, "wouldReap pid should match");
  console.log("  ✓ reap --dry-run --json lists stale job under wouldReap");

  // Actually reap
  const reapResult = await runCli(["reap", "--json"], unrelatedCwd);
  assert(reapResult.code === 0, `reap --json should exit 0, got ${reapResult.code}`);
  const reapPayload = JSON.parse(reapResult.stdout);
  assert("reaped" in reapPayload, "reap json should have reaped key");
  assert(Array.isArray(reapPayload.reaped), "reaped should be an array");
  assert(reapPayload.count >= 1, `reap count should be >= 1, got ${reapPayload.count}`);
  const reapedEntry = reapPayload.reaped.find((j) => j.jobId === sJobId);
  assert(reapedEntry !== undefined, "reaped should include the stale job");
  console.log("  ✓ reap --json reports reaped jobs");

  // Verify job was transitioned to failed
  const reapedRaw = await fs.readFile(sJobPath, "utf8");
  const reapedJob = JSON.parse(reapedRaw);
  assert(reapedJob.status === "failed", "reaped job should have status failed");
  assert(reapedJob.pid === null, "reaped job should have pid null");
  assert(
    reapedJob.error === "reaped — worker process no longer alive",
    `reaped job error should be the standard message, got: ${reapedJob.error}`,
  );
  assert(typeof reapedJob.completedAt === "string", "reaped job should have completedAt");
  console.log("  ✓ reaped job transitioned to status:failed with standard error message");

  // FIX 1: verify the workspace INDEX was also updated
  const ws3Dir = path.dirname(path.dirname(sJobPath));
  const ws3IndexFile = path.join(ws3Dir, "state.json");
  const ws3IndexRaw = await fs.readFile(ws3IndexFile, "utf8");
  const ws3Index = JSON.parse(ws3IndexRaw);
  const indexEntry = ws3Index.jobs.find((j) => j.id === sJobId);
  assert(indexEntry !== undefined, "reaped job should exist in workspace index");
  assert(indexEntry.status === "failed", `workspace index should show status:failed, got: ${indexEntry.status}`);
  assert(indexEntry.error === "reaped — worker process no longer alive", "workspace index should show reaped error");
  console.log("  ✓ workspace index updated to status:failed after reap");

  // FIX 2: stale job flipped to cancelled before reap — must not be overwritten
  const ws5Root = path.join(os.tmpdir(), "cc-delegate-xws-test-5");
  await fs.mkdir(ws5Root, { recursive: true });
  const cancelledBeforeReapId = `task-xws-cancelled-before-reap-${Date.now()}`;
  const { jobPath: cbrJobPath, workspaceDir: cbrWsDir } = await createSyntheticWorkspace(ws5Root, {
    id: cancelledBeforeReapId,
    status: "running",
    model: "guard-test-model",
    provider: "test-provider",
    pid: 99997, // dead pid → classified as stale
  });

  // Flip to cancelled on disk BEFORE reap runs
  const cbrBeforeRaw = await fs.readFile(cbrJobPath, "utf8");
  const cbrBefore = JSON.parse(cbrBeforeRaw);
  cbrBefore.status = "cancelled";
  cbrBefore.error = "cancelled by user";
  cbrBefore.cancelledAt = new Date().toISOString();
  cbrBefore.updatedAt = new Date().toISOString();
  cbrBefore.pid = null;
  await fs.writeFile(cbrJobPath, JSON.stringify(cbrBefore, null, 2));

  // Verify it IS classified as stale (still appears in listStaleJobsAnywhere — it reads
  // the file, sees "running" — wait, actually listStaleJobsAnywhere also reads files.
  // Let's check: if status is "cancelled", scanWorkspaceJobs filters to only
  // "running"/"queued", so it won't appear. That's fine — the guard test is about
  // postponing reap to a point where the classification race gap exists.
  // Instead, test reapJobAtPath directly.
  const reapResult2 = await reapJobAtPath(cbrJobPath);
  assert(!reapResult2.reaped, "FIX 2: reapJobAtPath should skip already-cancelled job");
  assert(reapResult2.reason === "no longer stale", `reason should be 'no longer stale', got: ${reapResult2.reason}`);

  // Verify the file is still cancelled, not overwritten to failed
  const cbrAfterRaw = await fs.readFile(cbrJobPath, "utf8");
  const cbrAfter = JSON.parse(cbrAfterRaw);
  assert(cbrAfter.status === "cancelled", `FIX 2 guard: job should stay cancelled, got: ${cbrAfter.status}`);
  assert(cbrAfter.error === "cancelled by user", "FIX 2 guard: error should be 'cancelled by user'");
  console.log("  ✓ FIX 2 guard: cancelled-before-reap is not overwritten to failed");

  cleanupDirs.push(cbrWsDir);

  // Second reap should report none
  const reap2Result = await runCli(["reap", "--json"], unrelatedCwd);
  const reap2Payload = JSON.parse(reap2Result.stdout);
  assert(reap2Payload.count === 0, `second reap should report 0 jobs, got ${reap2Payload.count}`);
  console.log("  ✓ second reap reports no stale jobs");

  // Human dry-run output
  const dryHuman = await runCli(["reap", "--dry-run"], unrelatedCwd);
  assert(dryHuman.stdout.includes("no stale jobs"), "dry-run should say 'no stale jobs' after reap");
  console.log("  ✓ human dry-run output correct");

  // stale: line in usage summary when stale exists (we need a fresh stale)
  const ws4Root = path.join(os.tmpdir(), "cc-delegate-xws-test-4");
  await fs.mkdir(ws4Root, { recursive: true });
  const staleJobId2 = `task-xws-stale2-${Date.now()}`;
  await createSyntheticWorkspace(ws4Root, {
    id: staleJobId2,
    status: "running",
    model: "stale-model-2",
    provider: "test-provider",
    mode: "text",
    pid: 99998,
  });

  const summary2 = await runCli(["usage", "--static"], unrelatedCwd);
  assert(summary2.code === 0, "usage --static should exit 0");
  assert(
    /stale:\s*\d+/.test(summary2.stdout),
    `usage summary should have 'stale: N' line when stale jobs exist\nstdout: ${summary2.stdout}`,
  );
  assert(
    summary2.stdout.includes("reap: cc-delegate reap"),
    "usage stale line should include 'reap: cc-delegate reap'",
  );
  console.log("  ✓ usage summary shows stale: line with reap hint");

  // stale line in status overview
  const statusResult = await runCli(["status"], unrelatedCwd);
  assert(statusResult.code === 0, "status should exit 0");
  assert(
    statusResult.stdout.includes("⚠") && statusResult.stdout.includes("stale"),
    `status overview should show stale warning\nstdout: ${statusResult.stdout}`,
  );
  console.log("  ✓ status overview shows stale warning");

  // ─── Cleanup ─────────────────────────────────────────────────────────
  console.log("\n--- Cleanup ---");
  await cleanup();
  // Also clean up the temp root dirs we created
  await fs.rm(ws1Root, { recursive: true, force: true });
  await fs.rm(ws2Root, { recursive: true, force: true });
  await fs.rm(ws3Root, { recursive: true, force: true });
  await fs.rm(ws4Root, { recursive: true, force: true });
  await fs.rm(ws5Root, { recursive: true, force: true }).catch(() => {});
  console.log("  ✓ synthetic workspaces cleaned up");

  // Confirm nothing was created under real ~/.claude/cc-delegate/state
  const realStateHome = path.join(os.homedir(), ".claude", "cc-delegate", "state");
  const tempStateHome = CC_DELEGATE_STATE_HOME;
  assert(
    tempStateHome.startsWith(os.tmpdir()),
    `temp state home should be under tmpdir, got: ${tempStateHome}`,
  );
  assert(
    !tempStateHome.startsWith(realStateHome),
    "temp state home should NOT overlap with real state home",
  );
  console.log("  ✓ isolated: temp home under tmpdir, not touching real ~/.claude/cc-delegate/state");

  console.log("\nAll cross-workspace lookup + usage/in-flight + stale/reap tests passed.");
}

runTests().catch(async (error) => {
  console.error("Test FAILED:", error.message);
  // Best-effort cleanup even on failure
  try { await cleanup(); } catch {}
  process.exit(1);
});