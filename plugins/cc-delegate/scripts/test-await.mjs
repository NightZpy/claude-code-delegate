import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getWorkspaceState } from "./lib/state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(__dirname, "companion.mjs");

// Helper to spawn and wait for CLI command
async function runCli(args, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [COMPANION, "-C", cwd, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    proc.on("error", reject);
  });
}

// Helper with hard timeout to detect hangs
async function runCliWithTimeout(args, cwd = process.cwd(), hardTimeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [COMPANION, "-C", cwd, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        proc.kill("SIGKILL");
        reject(new Error(`HANG: process did not exit within ${hardTimeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    }, hardTimeoutMs);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

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
async function addJobToIndex(cwd, jobsDir, jobId, jobData) {
  const indexFile = path.join(path.dirname(jobsDir), "state.json");
  
  let index = { version: 1, jobs: [] };
  try {
    const content = await fs.readFile(indexFile, "utf8");
    index = JSON.parse(content);
  } catch {}

  // Add job summary if not already there
  const exists = index.jobs.some(j => j.id === jobId);
  if (!exists) {
    index.jobs.unshift({
      id: jobId,
      status: jobData.status,
      model: jobData.model,
      createdAt: jobData.createdAt,
      updatedAt: jobData.updatedAt,
    });
  }

  await fs.writeFile(indexFile, JSON.stringify(index, null, 2));
}

// Test runner
async function runTests() {
  console.log("🧪 Testing await command...\n");
  const tempDir = await fs.mkdtemp("/tmp/cc-delegate-test-");
  console.log(`Using temp workspace: ${tempDir}`);

  try {
    // Get the workspace state for this cwd
    const workspace = await getWorkspaceState(tempDir);
    const jobsDir = workspace.jobsDir;
    await fs.mkdir(jobsDir, { recursive: true });
    console.log(`Found jobs directory: ${jobsDir}\n`);

    // Test 1: Completed job
    console.log("Test 1: Completed job (exit code 0)");
    const jobId1 = `task-${Date.now()}-completed`;
    const job1 = {
      id: jobId1,
      status: "completed",
      model: "qwen",
      provider: "openrouter",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: { content: "Test completed output" },
      cost: 0.001,
    };
    await fs.writeFile(path.join(jobsDir, `${jobId1}.json`), JSON.stringify(job1, null, 2));
    await addJobToIndex(tempDir, jobsDir, jobId1, job1);

    const result1 = await runCli(["await", jobId1, "--json"], tempDir);
    if (result1.code !== 0) {
      throw new Error(`Expected exit code 0, got ${result1.code}\nStderr: ${result1.stderr}`);
    }
    const payload1 = JSON.parse(result1.stdout);
    if (!payload1.jobId || !payload1.status || payload1.status !== "completed") {
      throw new Error(`Invalid payload: ${JSON.stringify(payload1)}`);
    }
    console.log("✓ Completed job returns exit code 0\n");

    // Test 2: Failed job
    console.log("Test 2: Failed job (exit code 20)");
    const jobId2 = `task-${Date.now()}-failed`;
    const job2 = {
      id: jobId2,
      status: "failed",
      model: "qwen",
      provider: "openrouter",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: "Test failure",
      cost: 0.001,
    };
    await fs.writeFile(path.join(jobsDir, `${jobId2}.json`), JSON.stringify(job2, null, 2));
    await addJobToIndex(tempDir, jobsDir, jobId2, job2);

    const result2 = await runCli(["await", jobId2, "--json"], tempDir);
    if (result2.code !== 20) {
      throw new Error(`Expected exit code 20, got ${result2.code}\nStderr: ${result2.stderr}`);
    }
    const payload2 = JSON.parse(result2.stdout);
    if (payload2.status !== "failed") {
      throw new Error(`Expected status 'failed', got ${payload2.status}`);
    }
    console.log("✓ Failed job returns exit code 20\n");

    // Test 3: Incomplete job
    console.log("Test 3: Incomplete job (exit code 21)");
    const jobId3 = `task-${Date.now()}-incomplete`;
    const job3 = {
      id: jobId3,
      status: "failed",
      incomplete: true,
      model: "qwen",
      provider: "openrouter",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: "Test incomplete",
      cost: 0.001,
    };
    await fs.writeFile(path.join(jobsDir, `${jobId3}.json`), JSON.stringify(job3, null, 2));
    await addJobToIndex(tempDir, jobsDir, jobId3, job3);

    const result3 = await runCli(["await", jobId3, "--json"], tempDir);
    if (result3.code !== 21) {
      throw new Error(`Expected exit code 21, got ${result3.code}\nStderr: ${result3.stderr}`);
    }
    const payload3 = JSON.parse(result3.stdout);
    if (payload3.status !== "incomplete") {
      throw new Error(`Expected status 'incomplete', got ${payload3.status}`);
    }
    console.log("✓ Incomplete job returns exit code 21\n");

    // Test 4: Cancelled job
    console.log("Test 4: Cancelled job (exit code 22)");
    const jobId4 = `task-${Date.now()}-cancelled`;
    const job4 = {
      id: jobId4,
      status: "cancelled",
      model: "qwen",
      provider: "openrouter",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cancelledAt: new Date().toISOString(),
      error: "cancelled by user",
      cost: 0.001,
    };
    await fs.writeFile(path.join(jobsDir, `${jobId4}.json`), JSON.stringify(job4, null, 2));
    await addJobToIndex(tempDir, jobsDir, jobId4, job4);

    const result4 = await runCli(["await", jobId4, "--json"], tempDir);
    if (result4.code !== 22) {
      throw new Error(`Expected exit code 22, got ${result4.code}\nStderr: ${result4.stderr}`);
    }
    const payload4 = JSON.parse(result4.stdout);
    if (payload4.status !== "cancelled") {
      throw new Error(`Expected status 'cancelled', got ${payload4.status}`);
    }
    console.log("✓ Cancelled job returns exit code 22\n");

    // Test 5: Timeout (running job with timeout)
    console.log("Test 5: Timeout (still-running job with --timeout, exit code 23)");
    const jobId5 = `task-${Date.now()}-running`;
    const job5 = {
      id: jobId5,
      status: "running",
      model: "qwen",
      provider: "openrouter",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: 99999,
      cost: 0.001,
    };
    await fs.writeFile(path.join(jobsDir, `${jobId5}.json`), JSON.stringify(job5, null, 2));
    await addJobToIndex(tempDir, jobsDir, jobId5, job5);

    const startTime = Date.now();
    const result5 = await runCli(["await", jobId5, "--timeout", "1", "--json"], tempDir);
    const elapsed = Date.now() - startTime;
    if (result5.code !== 23) {
      throw new Error(`Expected exit code 23, got ${result5.code}\nStderr: ${result5.stderr}`);
    }
    if (elapsed < 900) {
      throw new Error(`Expected timeout after ~1000ms, but got ${elapsed}ms`);
    }
    const payload5 = JSON.parse(result5.stdout);
    if (payload5.status !== "running") {
      throw new Error(`Expected status 'running', got ${payload5.status}`);
    }
    // Verify job was NOT modified (not cancelled)
    const checkJob = JSON.parse(await fs.readFile(path.join(jobsDir, `${jobId5}.json`), "utf8"));
    if (checkJob.status !== "running") {
      throw new Error("Job should still be running (not cancelled)");
    }
    console.log("✓ Timeout returns exit code 23 after ~1s, job unchanged\n");

    // Test 6: Multi-job (one completed + one failed = exit code 20)
    console.log("Test 6: Multi-job (completed + failed = exit code 20)");
    const jobId6a = `task-${Date.now()}-multi-1`;
    const jobId6b = `task-${Date.now()}-multi-2`;
    const job6a = {
      id: jobId6a,
      status: "completed",
      model: "qwen",
      provider: "openrouter",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: { content: "Completed" },
      cost: 0.001,
    };
    const job6b = {
      id: jobId6b,
      status: "failed",
      model: "qwen",
      provider: "openrouter",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: "Failed",
      cost: 0.001,
    };
    await fs.writeFile(path.join(jobsDir, `${jobId6a}.json`), JSON.stringify(job6a, null, 2));
    await fs.writeFile(path.join(jobsDir, `${jobId6b}.json`), JSON.stringify(job6b, null, 2));
    await addJobToIndex(tempDir, jobsDir, jobId6a, job6a);
    await addJobToIndex(tempDir, jobsDir, jobId6b, job6b);

    const result6 = await runCli(["await", jobId6a, jobId6b, "--json"], tempDir);
    if (result6.code !== 20) {
      throw new Error(`Expected exit code 20 (worst), got ${result6.code}\nStderr: ${result6.stderr}`);
    }
    const payload6 = JSON.parse(result6.stdout);
    if (!Array.isArray(payload6) || payload6.length !== 2) {
      throw new Error(`Expected array of 2 payloads, got ${JSON.stringify(payload6)}`);
    }
    console.log("✓ Multi-job returns worst exit code 20\n");

    // Test 7: JSON payload has all required fields
    console.log("Test 7: JSON payload has all required fields");
    const requiredFields = ["jobId", "status", "result", "costUsd", "elapsedMs", "model", "provider"];
    for (const field of requiredFields) {
      if (!(field in payload1)) {
        throw new Error(`Missing field '${field}' in JSON payload`);
      }
    }
    console.log(`✓ JSON payload has all 7 required fields\n`);

    // Test 8: --timeout 0 exits non-zero quickly (no hang)
    console.log("Test 8: --timeout 0 exits quickly with error");
    const startTime8 = Date.now();
    const result8 = await runCliWithTimeout(["await", jobId5, "--timeout", "0", "--json"], tempDir, 3000);
    const elapsed8 = Date.now() - startTime8;
    if (result8.code === 0) {
      throw new Error(`Expected non-zero exit for --timeout 0, got 0\nStderr: ${result8.stderr}`);
    }
    if (elapsed8 > 2000) {
      throw new Error(`--timeout 0 should fail fast, took ${elapsed8}ms`);
    }
    if (!result8.stderr.includes("--timeout requires a positive number of seconds")) {
      throw new Error(`Expected error message about positive number, got: ${result8.stderr}`);
    }
    console.log("✓ --timeout 0 exits non-zero quickly\n");

    // Test 9: --timeout abc exits non-zero quickly (no hang)
    console.log("Test 9: --timeout abc exits quickly with error");
    const startTime9 = Date.now();
    const result9 = await runCliWithTimeout(["await", jobId5, "--timeout", "abc", "--json"], tempDir, 3000);
    const elapsed9 = Date.now() - startTime9;
    if (result9.code === 0) {
      throw new Error(`Expected non-zero exit for --timeout abc, got 0\nStderr: ${result9.stderr}`);
    }
    if (elapsed9 > 2000) {
      throw new Error(`--timeout abc should fail fast, took ${elapsed9}ms`);
    }
    if (!result9.stderr.includes("--timeout requires a positive number of seconds")) {
      throw new Error(`Expected error message about positive number, got: ${result9.stderr}`);
    }
    console.log("✓ --timeout abc exits non-zero quickly\n");

    // Test 10: Multi-job concurrency — two running jobs with --timeout 1 return in ~1s total
    console.log("Test 10: Multi-job concurrency (two running jobs, --timeout 1)");
    const jobId10a = `task-${Date.now()}-concur-1`;
    const jobId10b = `task-${Date.now()}-concur-2`;
    const job10a = {
      id: jobId10a, status: "running", model: "qwen", provider: "openrouter",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), pid: 99991, cost: 0.001,
    };
    const job10b = {
      id: jobId10b, status: "running", model: "qwen", provider: "openrouter",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), pid: 99992, cost: 0.001,
    };
    await fs.writeFile(path.join(jobsDir, `${jobId10a}.json`), JSON.stringify(job10a, null, 2));
    await fs.writeFile(path.join(jobsDir, `${jobId10b}.json`), JSON.stringify(job10b, null, 2));
    await addJobToIndex(tempDir, jobsDir, jobId10a, job10a);
    await addJobToIndex(tempDir, jobsDir, jobId10b, job10b);

    const startTime10 = Date.now();
    const result10 = await runCli(["await", jobId10a, jobId10b, "--timeout", "1", "--json"], tempDir);
    const elapsed10 = Date.now() - startTime10;
    if (result10.code !== 23) {
      throw new Error(`Expected exit code 23 (timeout), got ${result10.code}\nStderr: ${result10.stderr}`);
    }
    if (elapsed10 > 2500) {
      throw new Error(`Concurrent await took ${elapsed10}ms — expected ~1000ms for parallel timeout (sequential would be ~2000ms)`);
    }
    const payload10 = JSON.parse(result10.stdout);
    if (!Array.isArray(payload10) || payload10.length !== 2) {
      throw new Error(`Expected array of 2 payloads, got ${JSON.stringify(payload10)}`);
    }
    console.log("✓ Multi-job concurrency returns in ~1s total (not ~2s)\n");

    // Test 11: nonexistent job errors without DEBUG noise
    console.log("Test 11: nonexistent job errors without DEBUG noise");
    const result11 = await runCliWithTimeout(["await", "nonexistent-job"], tempDir, 3000);
    if (result11.code === 0) {
      throw new Error(`Expected non-zero exit for nonexistent job, got 0`);
    }
    if (result11.stderr.includes("DEBUG")) {
      throw new Error(`stderr contains DEBUG noise: ${result11.stderr}`);
    }
    console.log("✓ nonexistent job errors without DEBUG noise\n");

    console.log("✅ All tests passed!");

  } finally {
    // Cleanup
    try {
      await fs.rm(tempDir, { recursive: true });
      console.log(`\nCleaned up temp workspace`);
    } catch {}
  }
}

runTests().catch((error) => {
  console.error("❌ Test failed:", error.message);
  process.exit(1);
});
