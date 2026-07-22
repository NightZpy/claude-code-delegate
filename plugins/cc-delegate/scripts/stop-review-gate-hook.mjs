#!/usr/bin/env node
import process from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(PLUGIN_ROOT, "scripts", "companion.mjs");

async function loadConfig() {
  // Same location config.mjs uses: CC_DELEGATE_HOME (~/.claude/cc-delegate).
  const home = process.env.CC_DELEGATE_HOME || path.join(os.homedir(), ".claude", "cc-delegate");
  const configPath = path.join(home, "config.json");
  try {
    const text = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(text);
    return { reviewGate: parsed.reviewGate || "off" };
  } catch {
    return { reviewGate: "off" };
  }
}

async function hasUncommittedChanges(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd, windowsHide: true });
    return stdout.trim().length > 0;
  } catch {
    return false; // fail open
  }
}

async function runReview(cwd) {
  const { reviewGate } = await loadConfig();
  if (reviewGate === "off") {
    console.log("ALLOW: review gate is disabled.");
    return { allow: true };
  }

  const changed = await hasUncommittedChanges(cwd);
  if (!changed) {
    console.log("ALLOW: no uncommitted changes.");
    return { allow: true };
  }

  // Run companion review --json synchronously with 10-min timeout
  let reviewJson;
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [COMPANION, "review", "--json"],
      { cwd, timeout: 10 * 60 * 1000, windowsHide: true, maxBuffer: 500 * 1024 },
    );
    reviewJson = JSON.parse(stdout);
  } catch (err) {
    // Any error: fail-open
    const errMsg = err.killed ? "review timed out" : (err.stderr || err.message);
    console.log(`ALLOW: review gate error: ${errMsg}`);
    return { allow: true };
  }

  if (reviewJson.verdict !== "fail") {
    console.log(`ALLOW: review passed (${reviewJson.summary || "no issues"}).`);
    return { allow: true };
  }

  // Verdict is fail
  const summary = reviewJson.summary || "review failures detected";
  const findingsSummary = (reviewJson.findings || []).slice(0, 3).map(f =>
    `- ${f.file || "?"}:${f.line || "?"} ${f.issue || "issue"}`
  ).join("\n");

  if (reviewGate === "enforce") {
    console.log(`BLOCK: ${summary}\nTop findings:\n${findingsSummary}`);
    process.exit(1);
  } else {
    // warn mode
    console.log(`ALLOW: review gate is WARN mode — verdict fail but allowing.`);
    process.stderr.write(`Review findings:\n${summary}\n${findingsSummary}\n`);
    return { allow: true };
  }
}

// Exposed for testing; actual execution below
async function main() {
  const cwd = process.cwd();
  await runReview(cwd);
}

main().catch((err) => {
  console.log(`ALLOW: unhandled error: ${err.message}`);
  process.exit(0);
});
