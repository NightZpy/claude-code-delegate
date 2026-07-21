import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/args.mjs";
import { ENV_FILE, USAGE_LEDGER_FILE, loadKeys, maskKey } from "./lib/env.mjs";
import { loadConfig } from "./lib/config.mjs";
import { runTrackedJob, spawnBackgroundWorker } from "./lib/jobs.mjs";
import { PROVIDERS, callProvider } from "./lib/providers.mjs";
import { renderProviderGuide } from "./lib/providerGuide.mjs";
import { buildQuotaSection, computeQuotaStatus, formatQuotaAlertLine, formatUsd2 } from "./lib/quota.mjs";
import {
  appendJobLog,
  createJob,
  findJob,
  findLatestFinishedJob,
  listJobs,
  loadJob,
  readJobLogTail,
  updateJob,
} from "./lib/state.mjs";

const execFileAsync = promisify(execFile);
const ENTRYPOINT = fileURLToPath(import.meta.url);
const DEFAULT_SYSTEM =
  "You are a senior software engineer executing one bounded task. Return complete code/diffs, no filler.";

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function asArray(value) {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function jobErrorMessage(job) {
  return job?.error || "task failed";
}

function normalizeUsage(usage) {
  return {
    prompt_tokens: Number(usage?.prompt_tokens || 0),
    completion_tokens: Number(usage?.completion_tokens || 0),
    total_tokens: Number(
      usage?.total_tokens ||
        Number(usage?.prompt_tokens || 0) + Number(usage?.completion_tokens || 0),
    ),
  };
}

function computeCost(pricing = {}, usage = {}) {
  const input = Number(pricing.input || 0);
  const output = Number(pricing.output || 0);
  const promptCost = (Number(usage.prompt_tokens || 0) / 1000000) * input;
  const completionCost = (Number(usage.completion_tokens || 0) / 1000000) * output;
  return Number((promptCost + completionCost).toFixed(6));
}

function formatSessionLabel(value) {
  if (value === null || value === undefined || value === "") {
    return "(no session)";
  }
  const text = String(value);
  return text.length > 8 ? `${text.slice(0, 8)}…` : text;
}

function formatCompactNumber(value) {
  const number = Number(value || 0);
  if (Math.abs(number) >= 1000000) {
    return `${(number / 1000000).toFixed(1)}M`;
  }
  if (Math.abs(number) >= 1000) {
    return `${(number / 1000).toFixed(1)}k`;
  }
  return String(Math.round(number));
}

function formatUsd(value) {
  const number = Number(value || 0);
  if (number === 0) {
    return "$0";
  }
  const rounded = number.toFixed(6);
  if (Number(rounded) === 0) {
    return "$0.000001";
  }
  return `$${rounded.replace(/0+$/, "").replace(/\.$/, "")}`;
}

function formatRelativeTime(timestamp) {
  const elapsedMs = Math.max(0, Date.now() - Date.parse(timestamp));
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function usageStyles() {
  if (!process.stdout.isTTY) {
    return { dim: (text) => text, cyan: (text) => text, red: (text) => text, yellow: (text) => text };
  }
  return {
    dim: (text) => `\x1b[2m${text}\x1b[0m`,
    cyan: (text) => `\x1b[36m${text}\x1b[0m`,
    red: (text) => `\x1b[31m${text}\x1b[0m`,
    yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  };
}

function formatJobIdShort(id) {
  if (!id) {
    return "-";
  }
  const text = String(id);
  return text.length > 16 ? `${text.slice(0, 16)}…` : text;
}

function formatUsageRow(name, stats, totalCost, styles, nameWidth) {
  const cost = Number(stats.cost || 0);
  const share = totalCost > 0 ? (cost / totalCost) * 100 : 0;
  const barWidth = cost > 0 ? Math.max(1, Math.round((share / 100) * 20)) : 0;
  const jobs = `${stats.jobs} job${stats.jobs === 1 ? "" : "s"}`;
  return `  ${name.padEnd(nameWidth)} ${styles.cyan("█".repeat(barWidth).padEnd(20))} ${share.toFixed(0).padStart(3)}%  ${jobs.padEnd(6)}  ${formatCompactNumber(stats.promptTokens)} in / ${formatCompactNumber(stats.completionTokens)} out   ${formatUsd(cost)}`;
}

function formatUsageRows(buckets, totalCost, styles, formatName = (name) => name) {
  const rows = sortUsageBuckets(buckets).map(([name, stats]) => [formatName(name), stats]);
  const nameWidth = Math.max(12, ...rows.map(([name]) => name.length));
  return rows.map(([name, stats]) => formatUsageRow(name, stats, totalCost, styles, nameWidth));
}

async function readUsageLedger() {
  try {
    const text = await fs.readFile(USAGE_LEDGER_FILE, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return [parsed];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function aggregateUsage(entries, roundCost = true) {
  const totals = {
    jobs: 0,
    promptTokens: 0,
    completionTokens: 0,
    cost: 0,
  };
  const byModel = {};
  const byProvider = {};
  const bySession = {};

  for (const entry of entries) {
    const model = String(entry.model || "unknown");
    const provider = String(entry.provider || "unknown");
    const sessionKey = entry.sessionId === null || entry.sessionId === undefined ? "null" : String(entry.sessionId);
    const promptTokens = Number(entry.promptTokens || 0);
    const completionTokens = Number(entry.completionTokens || 0);
    const cost = Number(entry.cost || 0);

    totals.jobs += 1;
    totals.promptTokens += promptTokens;
    totals.completionTokens += completionTokens;
    totals.cost += cost;

    if (!byModel[model]) {
      byModel[model] = { jobs: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    }
    if (!byProvider[provider]) {
      byProvider[provider] = { jobs: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    }
    if (!bySession[sessionKey]) {
      bySession[sessionKey] = { jobs: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    }

    for (const bucket of [byModel[model], byProvider[provider], bySession[sessionKey]]) {
      bucket.jobs += 1;
      bucket.promptTokens += promptTokens;
      bucket.completionTokens += completionTokens;
      bucket.cost += cost;
    }
  }

  if (roundCost) {
    totals.cost = Number(totals.cost.toFixed(6));
    for (const bucket of Object.values(byModel)) {
      bucket.cost = Number(bucket.cost.toFixed(6));
    }
    for (const bucket of Object.values(byProvider)) {
      bucket.cost = Number(bucket.cost.toFixed(6));
    }
    for (const bucket of Object.values(bySession)) {
      bucket.cost = Number(bucket.cost.toFixed(6));
    }
  }

  return { totals, byModel, byProvider, bySession };
}

function sortUsageBuckets(buckets) {
  return Object.entries(buckets).sort((left, right) => {
    const costDelta = Number(right[1].cost || 0) - Number(left[1].cost || 0);
    if (costDelta !== 0) {
      return costDelta;
    }
    return left[0].localeCompare(right[0]);
  });
}

function resolveLedgerFilter(entries, flags) {
  const modelFilter = typeof flags.model === "string" ? flags.model : null;
  const providerFilter = typeof flags.provider === "string" ? flags.provider : null;
  const sessionFilterRaw = flags.session;
  const days = flags.days !== undefined ? Number(flags.days) : null;
  const since =
    days !== null && Number.isFinite(days) && days >= 0
      ? new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      : null;
  let sessionFilter = null;

  if (sessionFilterRaw !== undefined) {
    if (sessionFilterRaw === true || sessionFilterRaw === "current") {
      if (!process.env.FRONTIER_SESSION_ID) {
        return { sessionError: "no current session id (FRONTIER_SESSION_ID not set)" };
      }
      sessionFilter = process.env.FRONTIER_SESSION_ID;
    } else if (sessionFilterRaw === null) {
      sessionFilter = null;
    } else {
      sessionFilter = String(sessionFilterRaw);
    }
  }

  const filtered = entries.filter((entry) => {
    if (modelFilter && entry.model !== modelFilter) {
      return false;
    }
    if (providerFilter && entry.provider !== providerFilter) {
      return false;
    }
    if (sessionFilter) {
      const sessionId = entry.sessionId === null || entry.sessionId === undefined ? null : String(entry.sessionId);
      if (!sessionId || !sessionId.startsWith(sessionFilter)) {
        return false;
      }
    }
    if (since && Date.parse(entry.ts) < since.getTime()) {
      return false;
    }
    return true;
  });

  return { filtered, since, sessionFilter, days, sessionError: null };
}

function normalizeLedgerEntry(entry) {
  return {
    ...entry,
    attempts: entry.attempts === undefined ? 1 : Number(entry.attempts),
    failedProviders: Array.isArray(entry.failedProviders) ? entry.failedProviders : [],
    latencyMs: entry.latencyMs ?? null,
  };
}

function formatLatency(ms) {
  if (ms === null || ms === undefined) {
    return "-";
  }
  const number = Number(ms);
  if (!Number.isFinite(number)) {
    return "-";
  }
  return number >= 1000 ? `${(number / 1000).toFixed(1)}s` : `${Math.round(number)}ms`;
}

function formatPercent(value) {
  return `${Math.round(value)}%`;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, fraction) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function renderTable(headers, rows, colorRow) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row.cells[index]).length)),
  );
  const pad = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index]));
  const lines = [pad(headers).join("  ")];
  for (const row of rows) {
    const padded = pad(row.cells);
    lines.push((colorRow ? colorRow(padded, row) : padded).join("  "));
  }
  return lines.join("\n");
}

async function usageCommand(flags) {
  if (flags.details) {
    await usageDetailsCommand(flags);
    return;
  }
  if (flags.health) {
    await usageHealthCommand(flags);
    return;
  }

  const entries = await readUsageLedger();
  const { filtered, since, sessionFilter, days, sessionError } = resolveLedgerFilter(entries, flags);
  if (sessionError) {
    process.stdout.write(`${sessionError}\n`);
    return;
  }

  const payload = {
    ...aggregateUsage(filtered),
    since: since ? since.toISOString() : null,
  };

  const config = await loadConfig();

  if (flags.json) {
    for (const [provider, monthlyUsd] of Object.entries(config.quotas)) {
      const quota = computeQuotaStatus(provider, monthlyUsd, entries);
      if (!quota) {
        continue;
      }
      if (!payload.byProvider[provider]) {
        payload.byProvider[provider] = { jobs: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
      }
      payload.byProvider[provider].quota = quota;
    }
    printJson(payload);
    return;
  }

  const styles = usageStyles();
  const quotaSection = buildQuotaSection(config, entries, styles);

  if (!filtered.length) {
    if (!quotaSection) {
      process.stdout.write("no usage recorded yet\n");
      return;
    }
    const emptySections = [`Quotas (this month)\n${quotaSection.rows.join("\n")}`];
    if (quotaSection.alerts.length) {
      emptySections.push(quotaSection.alerts.join("\n"));
    }
    process.stdout.write(`${emptySections.join("\n\n")}\n`);
    return;
  }

  const displayUsage = aggregateUsage(filtered, false);
  const newestTimestamp = filtered.reduce((newest, entry) =>
    !newest || Date.parse(entry.ts) > Date.parse(newest) ? entry.ts : newest,
  null);
  const scope = sessionFilter
    ? `session ${formatSessionLabel(sessionFilter)}`
    : since
      ? `last ${days} days`
      : "all time";
  const summaryValues = [
    ["jobs", String(displayUsage.totals.jobs)],
    ["tokens in", formatCompactNumber(displayUsage.totals.promptTokens)],
    ["tokens out", formatCompactNumber(displayUsage.totals.completionTokens)],
    ["total cost USD", formatUsd(displayUsage.totals.cost)],
    ["avg cost per job", formatUsd(displayUsage.totals.cost / displayUsage.totals.jobs)],
    ["last activity", newestTimestamp ? formatRelativeTime(newestTimestamp) : "unknown"],
  ];
  const labelWidth = Math.max(...summaryValues.map(([label]) => label.length));
  const summary = summaryValues.map(([label, value]) =>
    `  ${styles.dim(`${label}:`.padEnd(labelWidth + 1))} ${value}`,
  );
  const totalCost = Number(displayUsage.totals.cost || 0);
  const modelRows = formatUsageRows(displayUsage.byModel, totalCost, styles);
  const providerRows = formatUsageRows(displayUsage.byProvider, totalCost, styles);
  const sessionRows = formatUsageRows(displayUsage.bySession, totalCost, styles, (name) => {
    const sessionId = name === "null" ? null : name;
    const current = sessionId && sessionId === process.env.FRONTIER_SESSION_ID ? " (current)" : "";
    return `${formatSessionLabel(sessionId)}${current}`;
  });

  const sections = [
    `Frontier usage — ${scope}`,
    summary.join("\n"),
    `By model\n${modelRows.join("\n")}`,
    `By provider\n${providerRows.join("\n")}`,
    `By session\n${sessionRows.join("\n")}`,
  ];
  if (quotaSection) {
    sections.push(`Quotas (this month)\n${quotaSection.rows.join("\n")}`);
  }
  if (quotaSection?.alerts.length) {
    sections.push(quotaSection.alerts.join("\n"));
  }
  sections.push(
    styles.dim(
      "views: usage --details · usage --health   filters: --days N · --model <alias> · --provider <name> · --session current",
    ),
  );
  process.stdout.write(`${sections.join("\n\n")}\n`);
}

async function usageDetailsCommand(flags) {
  const entries = await readUsageLedger();
  const { filtered, sessionError } = resolveLedgerFilter(entries, flags);
  if (sessionError) {
    process.stdout.write(`${sessionError}\n`);
    return;
  }

  const limit = flags.limit !== undefined && Number.isFinite(Number(flags.limit)) ? Number(flags.limit) : 20;
  const sorted = [...filtered].sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts));
  const limited = sorted.slice(0, Math.max(0, limit));

  if (flags.json) {
    printJson(limited);
    return;
  }

  if (!limited.length) {
    process.stdout.write("no usage recorded yet\n");
    return;
  }

  const styles = usageStyles();
  const headers = ["TIME", "JOB", "MODEL", "PROVIDER", "IN", "OUT", "COST", "LATENCY", "STATUS"];
  const rows = limited.map((raw) => {
    const entry = normalizeLedgerEntry(raw);
    const failed = entry.status !== "completed";
    return {
      cells: [
        formatRelativeTime(entry.ts),
        formatJobIdShort(entry.jobId),
        String(entry.model || "-"),
        String(entry.provider || "-"),
        formatCompactNumber(entry.promptTokens),
        formatCompactNumber(entry.completionTokens),
        formatUsd(entry.cost),
        formatLatency(entry.latencyMs),
        failed ? "failed" : "completed",
      ],
      failed,
    };
  });

  const table = renderTable(headers, rows, (cells, row) => {
    if (!row.failed) {
      return cells;
    }
    const dimmed = cells.map((cell) => styles.dim(cell));
    dimmed[dimmed.length - 1] = styles.red(cells[cells.length - 1]);
    return dimmed;
  });

  process.stdout.write(`${table}\n`);
}

function computeGroupStats(entries, names, keyOf) {
  return names.map((name) => {
    const group = entries.filter((entry) => keyOf(entry) === name);
    const reqs = group.length;
    const successes = group.filter((entry) => entry.status === "completed");
    const successPct = reqs ? (successes.length / reqs) * 100 : 0;
    const latencies = successes.map((entry) => entry.latencyMs).filter((value) => value !== null && value !== undefined);
    const fallbackCount = group.filter((entry) => entry.failedProviders.length > 0).length;
    const totalCost = group.reduce((sum, entry) => sum + Number(entry.cost || 0), 0);
    const errorTimestamps = group
      .filter((entry) => entry.status === "failed" || entry.failedProviders.length > 0)
      .map((entry) => entry.ts);

    return {
      name,
      reqs,
      successPct,
      avgLatencyMs: latencies.length ? average(latencies) : null,
      p95LatencyMs: latencies.length ? percentile(latencies, 0.95) : null,
      fallbackPct: reqs ? (fallbackCount / reqs) * 100 : 0,
      avgCostPerReq: reqs ? totalCost / reqs : null,
      lastError: errorTimestamps.length
        ? errorTimestamps.reduce((latest, ts) => (Date.parse(ts) > Date.parse(latest) ? ts : latest))
        : null,
    };
  });
}

function computeProviderStats(entries, providerNames) {
  return providerNames.map((name) => {
    const involved = entries.filter(
      (entry) => (entry.status === "completed" && entry.provider === name) || entry.failedProviders.includes(name),
    );
    const successes = involved.filter((entry) => entry.status === "completed" && entry.provider === name);
    const fallbackHits = involved.filter((entry) => entry.failedProviders.includes(name));
    const reqs = involved.length;
    const latencies = successes.map((entry) => entry.latencyMs).filter((value) => value !== null && value !== undefined);
    const totalCost = successes.reduce((sum, entry) => sum + Number(entry.cost || 0), 0);

    return {
      name,
      reqs,
      successPct: reqs ? (successes.length / reqs) * 100 : 0,
      avgLatencyMs: latencies.length ? average(latencies) : null,
      p95LatencyMs: latencies.length ? percentile(latencies, 0.95) : null,
      fallbackPct: reqs ? (fallbackHits.length / reqs) * 100 : 0,
      avgCostPerReq: reqs ? totalCost / reqs : null,
      lastError: fallbackHits.length
        ? fallbackHits.map((entry) => entry.ts).reduce((latest, ts) => (Date.parse(ts) > Date.parse(latest) ? ts : latest))
        : null,
    };
  });
}

function buildHealthWarnings(rows, adviceSuffix) {
  const warnings = [];
  for (const row of rows) {
    if (row.reqs >= 5 && row.successPct < 80) {
      warnings.push(`⚠ ${row.name}: success ${Math.round(row.successPct)}% over ${row.reqs} reqs — ${adviceSuffix}`);
    }
    if (row.p95LatencyMs !== null && row.p95LatencyMs > 60000) {
      warnings.push(`⚠ ${row.name}: p95 latency ${formatLatency(row.p95LatencyMs)} over ${row.reqs} reqs — ${adviceSuffix}`);
    }
    if (row.fallbackPct > 30) {
      warnings.push(`⚠ ${row.name}: fallback rate ${Math.round(row.fallbackPct)}% over ${row.reqs} reqs — ${adviceSuffix}`);
    }
  }
  return warnings;
}

function healthRowToJson(row) {
  return {
    name: row.name,
    reqs: row.reqs,
    successPct: Number(row.successPct.toFixed(1)),
    avgLatencyMs: row.avgLatencyMs === null ? null : Math.round(row.avgLatencyMs),
    p95LatencyMs: row.p95LatencyMs === null ? null : Math.round(row.p95LatencyMs),
    fallbackPct: Number(row.fallbackPct.toFixed(1)),
    avgCostPerReq: row.avgCostPerReq === null ? null : Number(row.avgCostPerReq.toFixed(6)),
    lastError: row.lastError,
  };
}

function healthRowCells(row) {
  return [
    row.name,
    String(row.reqs),
    formatPercent(row.successPct),
    formatLatency(row.avgLatencyMs),
    formatLatency(row.p95LatencyMs),
    formatPercent(row.fallbackPct),
    row.avgCostPerReq === null ? "-" : formatUsd(row.avgCostPerReq),
    row.lastError ? formatRelativeTime(row.lastError) : "-",
  ];
}

async function usageHealthCommand(flags) {
  const entries = await readUsageLedger();
  const { filtered, sessionError } = resolveLedgerFilter(entries, flags);
  if (sessionError) {
    process.stdout.write(`${sessionError}\n`);
    return;
  }

  const normalized = filtered.map(normalizeLedgerEntry);
  const modelNames = [...new Set(normalized.map((entry) => String(entry.model || "unknown")))].sort();
  const providerNamesFromLedger = new Set();
  for (const entry of normalized) {
    if (entry.status === "completed" && entry.provider) {
      providerNamesFromLedger.add(entry.provider);
    }
    for (const failedProvider of entry.failedProviders) {
      providerNamesFromLedger.add(failedProvider);
    }
  }
  const providerNames = [...providerNamesFromLedger].sort();

  const modelStats = computeGroupStats(normalized, modelNames, (entry) => String(entry.model || "unknown"));
  const providerStats = computeProviderStats(normalized, providerNames);
  const warnings = [
    ...buildHealthWarnings(modelStats, "investigate before relying on it further"),
    ...buildHealthWarnings(providerStats, "consider demoting it in models.json"),
  ];

  if (flags.json) {
    printJson({
      models: modelStats.map(healthRowToJson),
      providers: providerStats.map(healthRowToJson),
      warnings,
    });
    return;
  }

  if (!normalized.length) {
    process.stdout.write("no usage recorded yet\n");
    return;
  }

  const headers = ["NAME", "REQS", "SUCCESS%", "AVG LATENCY", "P95 LATENCY", "FALLBACK%", "AVG COST/REQ", "LAST ERROR"];
  const modelTable = renderTable(headers, modelStats.map((row) => ({ cells: healthRowCells(row) })));
  const providerTable = renderTable(headers, providerStats.map((row) => ({ cells: healthRowCells(row) })));

  const sections = [`By model\n${modelTable}`, `By provider\n${providerTable}`];
  if (warnings.length) {
    sections.push(warnings.join("\n"));
  }
  process.stdout.write(`${sections.join("\n\n")}\n`);
}

async function readModelsRegistry() {
  const file = path.resolve(path.dirname(ENTRYPOINT), "..", "config", "models.json");
  const text = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(text);
  return parsed.models || {};
}

async function readPrompt(flags, positionals) {
  const positionalPrompt = positionals.join(" ").trim();
  if (positionalPrompt) {
    return positionalPrompt;
  }

  if (typeof flags["prompt-file"] === "string") {
    return fs.readFile(path.resolve(flags["prompt-file"]), "utf8");
  }

  if (!process.stdin.isTTY) {
    let text = "";
    for await (const chunk of process.stdin) {
      text += chunk;
    }
    if (text.trim()) {
      return text.trimEnd();
    }
  }

  throw new Error("prompt required via positional arg, --prompt-file, or stdin");
}

async function readFileAttachments(cwd, files) {
  const parts = [];

  for (const original of files) {
    const filePath = path.resolve(cwd, original);
    const content = await fs.readFile(filePath, "utf8");
    parts.push(`Attached file: ${original}\n\`\`\`\n${content}\n\`\`\``);
  }

  return parts;
}

async function readGitDiff(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "HEAD"], {
      cwd,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    const sections = [
      stdout.trim()
        ? `Git diff against HEAD\n\`\`\`diff\n${stdout.trimEnd()}\n\`\`\``
        : "Git diff against HEAD\n```diff\n# no changes\n```",
    ];
    // git diff HEAD omits untracked files; inline them so new files are reviewable too.
    const { stdout: untracked } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
    );
    for (const file of untracked.split("\n").filter(Boolean)) {
      try {
        const content = await fs.readFile(path.resolve(cwd, file), "utf8");
        sections.push(`New untracked file: ${file}\n\`\`\`\n${content}\n\`\`\``);
      } catch {
        // ponytail: binary/unreadable untracked files are skipped silently
      }
    }
    return sections.join("\n\n");
  } catch (error) {
    const message = error.stderr?.trim() || error.message || String(error);
    throw new Error(`unable to read git diff: ${message}`);
  }
}

function buildUserMessage(prompt, fileBlocks, diffBlock) {
  const parts = [prompt.trim()];
  if (fileBlocks.length) {
    parts.push(fileBlocks.join("\n\n"));
  }
  if (diffBlock) {
    parts.push(diffBlock);
  }
  return parts.join("\n\n");
}

function resolveModelSelection(models, requestedModel, forcedProvider) {
  const modelName = requestedModel || "qwen";
  const registryEntry = models[modelName];

  if (registryEntry) {
    const providers = forcedProvider
      ? registryEntry.providers.filter((provider) => provider.name === forcedProvider)
      : registryEntry.providers;
    if (!providers.length) {
      throw new Error(`provider ${forcedProvider} is not configured for model ${modelName}`);
    }

    return {
      alias: modelName,
      label: registryEntry.label,
      pricing: registryEntry.pricing,
      providers,
    };
  }

  if (!forcedProvider) {
    throw new Error(`model ${modelName} is not a registry alias; pass --provider with a full model id`);
  }

  if (!PROVIDERS[forcedProvider]) {
    throw new Error(`unknown provider ${forcedProvider}`);
  }

  return {
    alias: modelName,
    label: modelName,
    pricing: { input: 0, output: 0 },
    providers: [{ name: forcedProvider, id: modelName }],
  };
}

async function executeTaskRequest(job, models, request, tools) {
  const selection = resolveModelSelection(models, request.model, request.provider);
  const messages = [
    { role: "system", content: request.system || DEFAULT_SYSTEM },
    { role: "user", content: request.prompt },
  ];

  let missingKeyCount = 0;
  let lastError = null;
  const attempts = [];

  for (const candidate of selection.providers) {
    const providerConfig = PROVIDERS[candidate.name];
    const keyPresent = Boolean(process.env[providerConfig?.envKey || ""]);

    const attempt = {
      provider: candidate.name,
      modelId: candidate.id,
      startedAt: new Date().toISOString(),
    };
    attempts.push(attempt);
    await tools.log(`attempting ${candidate.name} with model ${candidate.id}`);

    if (!keyPresent) {
      attempt.outcome = "missing-key";
      missingKeyCount += 1;
      await tools.log(`skipping ${candidate.name}: missing ${providerConfig.envKey}`);
      continue;
    }

    try {
      const callStartedAt = Date.now();
      const response = await callProvider(candidate.name, candidate.id, messages, {
        maxTokens: request.maxTokens,
      });
      const latencyMs = Date.now() - callStartedAt;
      const usage = normalizeUsage(response.usage);
      const content =
        response.choices?.[0]?.message?.content ??
        response.choices?.[0]?.text ??
        "";
      const cost = computeCost(candidate.pricing || selection.pricing, usage);
      attempt.outcome = "success";
      attempt.finishedAt = new Date().toISOString();
      await tools.setJob({
        attempts,
        provider: candidate.name,
      });
      return {
        provider: candidate.name,
        attempts,
        usage,
        cost,
        latencyMs,
        result: {
          content,
          raw: response,
          modelId: candidate.id,
          alias: selection.alias,
          provider: candidate.name,
        },
      };
    } catch (error) {
      lastError = error;
      attempt.outcome = "error";
      attempt.error = error.message || String(error);
      attempt.finishedAt = new Date().toISOString();
      await tools.log(`provider ${candidate.name} failed: ${attempt.error}`);
      await tools.setJob({ attempts });
    }
  }

  if (missingKeyCount === selection.providers.length) {
    const setupScript = path.join(path.dirname(ENTRYPOINT), "setup-keys.mjs");
    const wanted = selection.providers.map((p) => p.name).join(", ");
    throw new Error(
      `no API key configured for any provider of model ${selection.alias} (needs one of: ${wanted}). ` +
        `Configure keys: in Claude Code type \`! frontier-keys\`, or run in your terminal:\n` +
        `  node "${setupScript}"`,
    );
  }

  throw new Error(lastError?.message || `all providers failed for model ${selection.alias}`);
}

function summarizeJobForOutput(job, progressPreview) {
  const startedAt = job.createdAt;
  const endedAt = job.completedAt || job.cancelledAt || job.updatedAt;
  const elapsedMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    cancelledAt: job.cancelledAt,
    pid: job.pid,
    model: job.model,
    provider: job.provider,
    tokens: job.usage,
    cost: job.cost,
    error: job.error,
    elapsedMs,
    progressPreview,
  };
}

async function buildStatusPayload(cwd, jobId, all = false) {
  if (jobId) {
    const job = await findJob(cwd, jobId);
    if (!job) {
      throw new Error(`job ${jobId} not found`);
    }
    const progressPreview = await readJobLogTail(cwd, job.id, 8);
    return summarizeJobForOutput(job, progressPreview);
  }

  const jobs = await listJobs(cwd);
  const recent = jobs.slice(0, all ? jobs.length : 8);
  const runningJobs = [];
  const recentSummaries = [];
  let latestFinished = null;

  for (const summary of recent) {
    const job = await loadJob(cwd, summary.id);
    const progressPreview = await readJobLogTail(cwd, summary.id, 5);
    const formatted = summarizeJobForOutput(job, progressPreview);
    recentSummaries.push(formatted);
    if (formatted.status === "running") {
      runningJobs.push(formatted);
    }
    if (!latestFinished && ["completed", "failed", "cancelled"].includes(formatted.status)) {
      latestFinished = formatted;
    }
  }

  return {
    runningJobs,
    latestFinished,
    recent: recentSummaries,
  };
}

function printModelsHuman(models) {
  const lines = [];
  for (const [alias, model] of Object.entries(models)) {
    const providerList = model.providers.map((provider) => `${provider.name}:${provider.id}`).join(", ");
    const notes = [model.label, model.tier, model._verify ? "verify:true" : null].filter(Boolean).join(" | ");
    lines.push(`${alias}`);
    lines.push(`  providers: ${providerList}`);
    lines.push(`  context: ${model.context}`);
    lines.push(`  notes: ${notes}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function setupCommand(flags) {
  const keys = await loadKeys();
  const payload = {
    ready: Object.values(keys.values).some(Boolean),
    envFile: ENV_FILE,
    providers: {
      openrouter: {
        keyPresent: Boolean(keys.values.OPENROUTER_API_KEY),
        keyHint: keys.values.OPENROUTER_API_KEY ? maskKey(keys.values.OPENROUTER_API_KEY) : null,
      },
      siliconflow: {
        keyPresent: Boolean(keys.values.SILICONFLOW_API_KEY),
        keyHint: keys.values.SILICONFLOW_API_KEY ? maskKey(keys.values.SILICONFLOW_API_KEY) : null,
      },
      deepinfra: {
        keyPresent: Boolean(keys.values.DEEPINFRA_API_KEY),
        keyHint: keys.values.DEEPINFRA_API_KEY ? maskKey(keys.values.DEEPINFRA_API_KEY) : null,
      },
      cerebras: {
        keyPresent: Boolean(keys.values.CEREBRAS_API_KEY),
        keyHint: keys.values.CEREBRAS_API_KEY ? maskKey(keys.values.CEREBRAS_API_KEY) : null,
      },
    },
  };

  const config = await loadConfig();
  const entries = await readUsageLedger();
  for (const [provider, data] of Object.entries(payload.providers)) {
    const monthlyUsd = config.quotas[provider];
    if (monthlyUsd === undefined) {
      continue;
    }
    data.quota = computeQuotaStatus(provider, monthlyUsd, entries);
  }

  if (flags.json) {
    printJson(payload);
    return;
  }

  const lines = [
    `ready: ${payload.ready ? "yes" : "no"}`,
    `node: ${process.version}`,
    `env file: ${payload.envFile}`,
  ];
  for (const [provider, data] of Object.entries(payload.providers)) {
    let line = `${provider}: ${data.keyHint || "missing"}`;
    if (data.quota) {
      const icon = data.quota.level === "critical" ? " 🔴" : data.quota.level === "warning" ? " ⚠" : "";
      line += ` — quota ${formatUsd2(data.quota.monthlyUsd)}/mo, ${formatUsd2(data.quota.spentThisMonth)} spent (${Math.round(data.quota.pct)}%)${icon}`;
    }
    lines.push(line);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function modelsCommand(flags) {
  const models = await readModelsRegistry();

  if (flags.guide) {
    process.stdout.write(`${renderProviderGuide(models)}\n`);
    return;
  }

  const payload = Object.entries(models).map(([alias, model]) => ({
    alias,
    label: model.label,
    providers: model.providers,
    context: model.context,
    notes: [model.tier, model._verify ? "_verify:true" : null].filter(Boolean).join(", "),
  }));

  if (flags.json) {
    printJson(payload);
    return;
  }

  printModelsHuman(models);
}

async function createTaskJob(cwd, flags, positionals) {
  const prompt = await readPrompt(flags, positionals);
  const fileBlocks = await readFileAttachments(cwd, asArray(flags.file));
  const diffBlock = flags.diff ? await readGitDiff(cwd) : null;
  const userPrompt = buildUserMessage(prompt, fileBlocks, diffBlock);
  const request = {
    model: String(flags.model || "qwen"),
    provider: typeof flags.provider === "string" ? flags.provider : null,
    system: typeof flags.system === "string" ? flags.system : DEFAULT_SYSTEM,
    maxTokens: flags["max-tokens"] !== undefined ? Number(flags["max-tokens"]) : undefined,
    prompt: userPrompt,
  };

  const job = await createJob(cwd, {
    cwd,
    command: "task",
    model: request.model,
    promptPreview: prompt.slice(0, 140),
    request,
  });

  return job;
}

// Non-blocking: quota alerts never fail or delay the task, they're just recorded
// on the job (log + a `quota`/`quotaAlert` field) so foreground and background
// callers can both surface them.
async function attachQuotaAlert(cwd, job) {
  // Non-blocking by contract: any failure here must never turn a completed
  // (and already billed) task into an apparent failure.
  try {
    if (job.status !== "completed" || !job.provider) {
      return job;
    }
    const config = await loadConfig();
    const monthlyUsd = config.quotas[job.provider];
    if (monthlyUsd === undefined) {
      return job;
    }
    const entries = await readUsageLedger();
    const quota = computeQuotaStatus(job.provider, monthlyUsd, entries);
    if (!quota) {
      return job;
    }
    const patch = { quota };
    if (quota.level !== "ok") {
      patch.quotaAlert = [formatQuotaAlertLine(job.provider, quota)];
      await appendJobLog(cwd, job.id, patch.quotaAlert[0]);
    }
    return await updateJob(cwd, job.id, patch);
  } catch {
    return job;
  }
}

async function runTask(cwd, job) {
  await loadKeys();
  const models = await readModelsRegistry();
  const completed = await runTrackedJob(cwd, job.id, async (tools) => {
    const outcome = await executeTaskRequest(job, models, job.request, tools);
    return outcome;
  });
  return attachQuotaAlert(cwd, completed);
}

async function taskCommand(cwd, flags, positionals) {
  const job = await createTaskJob(cwd, flags, positionals);

  if (flags.background) {
    const workerPid = spawnBackgroundWorker(ENTRYPOINT, cwd, job.id);
    const queued = await updateJob(cwd, job.id, {
      status: "queued",
      pid: workerPid,
    });
    await appendJobLog(cwd, job.id, `background worker spawned with pid ${workerPid}`);
    printJson({ jobId: queued.id });
    return 0;
  }

  const completed = await runTask(cwd, job);
  if (flags.json) {
    printJson(completed);
  } else if (completed.status === "completed") {
    const alertPrefix = completed.quotaAlert?.length ? `${completed.quotaAlert.join("\n")}\n\n` : "";
    process.stdout.write(`${alertPrefix}${completed.result?.content || ""}\n`);
  } else {
    process.stderr.write(`${jobErrorMessage(completed)}\n`);
  }
  return completed.status === "completed" ? 0 : 1;
}

async function taskWorkerCommand(cwd, flags) {
  const jobId = String(flags["job-id"] || "");
  if (!jobId) {
    throw new Error("task-worker requires --job-id");
  }
  const job = await findJob(cwd, jobId);
  if (!job) {
    throw new Error(`job ${jobId} not found`);
  }
  await runTask(cwd, job);
  return 0;
}

async function statusCommand(cwd, flags, positionals) {
  const jobId = positionals[0];
  const payload = await buildStatusPayload(cwd, jobId, Boolean(flags.all));
  if (flags.json) {
    printJson(payload);
    return;
  }

  const lines = [];
  if (jobId) {
    lines.push(`${payload.id} ${payload.status} elapsed=${payload.elapsedMs}ms`);
    for (const line of payload.progressPreview) {
      lines.push(`  ${line}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  lines.push(`running: ${payload.runningJobs.length}`);
  if (payload.latestFinished) {
    lines.push(`latest finished: ${payload.latestFinished.id} ${payload.latestFinished.status}`);
  }
  for (const job of payload.recent) {
    lines.push(`${job.id} ${job.status} elapsed=${job.elapsedMs}ms`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function resultCommand(cwd, flags, positionals) {
  const jobId = positionals[0];
  const job = jobId ? await findJob(cwd, jobId) : await findLatestFinishedJob(cwd);
  if (!job) {
    throw new Error(jobId ? `job ${jobId} not found` : "no finished jobs found");
  }

  const payload = {
    id: job.id,
    status: job.status,
    model: job.result?.alias || job.model,
    modelId: job.result?.modelId || null,
    provider: job.result?.provider || job.provider,
    usage: job.usage,
    cost: job.cost,
    error: job.error,
    output: job.result?.content || null,
    quota: job.quota || null,
  };

  if (flags.json) {
    printJson(payload);
    return;
  }

  const alertPrefix = job.quotaAlert?.length ? `${job.quotaAlert.join("\n")}\n\n` : "";

  if (payload.output) {
    process.stdout.write(`${alertPrefix}${payload.output}\n`);
    return;
  }

  process.stdout.write(`${alertPrefix}${payload.error || "no output stored"}\n`);
}

async function cancelCommand(cwd, positionals) {
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("cancel requires a job id");
  }

  const job = await findJob(cwd, jobId);
  if (!job) {
    throw new Error(`job ${jobId} not found`);
  }

  if (job.pid) {
    try {
      process.kill(-job.pid, "SIGTERM");
    } catch {
      try {
        process.kill(job.pid, "SIGTERM");
      } catch {
        // ignored
      }
    }
  }

  const cancelled = await updateJob(cwd, jobId, {
    status: "cancelled",
    pid: null,
    error: "cancelled by user",
  });
  await appendJobLog(cwd, jobId, "job cancelled by user");
  process.stdout.write(`${cancelled.id}\n`);
}

async function linkCommand() {
  const scriptsDir = path.dirname(ENTRYPOINT);
  const pluginRoot = path.dirname(scriptsDir);
  const versionsRoot = path.dirname(pluginRoot);
  const isVersionedInstall = /^\d+\.\d+\.\d+$/.test(path.basename(pluginRoot));
  const binDir = path.join(os.homedir(), ".local", "bin");
  await fs.mkdir(binDir, { recursive: true });

  const wrappers = [
    { name: "frontier", rel: "scripts/frontier-companion.mjs" },
    { name: "frontier-keys", rel: "scripts/setup-keys.mjs" },
  ];
  for (const wrapper of wrappers) {
    // ponytail: latest-by-mtime picks the newest installed plugin version; good
    // enough because the plugin updater always touches the new version dir last.
    const body = isVersionedInstall
      ? `#!/bin/sh\nDIR="$(ls -td "${versionsRoot}"/*/ 2>/dev/null | head -1)"\nexec node "\${DIR}${wrapper.rel}" "$@"\n`
      : `#!/bin/sh\nexec node "${path.join(pluginRoot, wrapper.rel)}" "$@"\n`;
    const dest = path.join(binDir, wrapper.name);
    await fs.writeFile(dest, body, "utf8");
    await fs.chmod(dest, 0o755);
    process.stdout.write(`linked ${dest}\n`);
  }

  const onPath = (process.env.PATH || "").split(path.delimiter).includes(binDir);
  if (!onPath) {
    process.stdout.write(
      `\n${binDir} is not on your PATH. Add this to your shell profile:\n  export PATH="$HOME/.local/bin:$PATH"\n`,
    );
  }
}

async function main() {
  const { command, cwd, flags, positionals } = parseArgs();

  if (!command) {
    throw new Error("subcommand required: setup, models, task, task-worker, status, result, cancel, usage, link");
  }

  switch (command) {
    case "setup":
      await setupCommand(flags);
      return 0;
    case "models":
      await modelsCommand(flags);
      return 0;
    case "task":
      return taskCommand(cwd, flags, positionals);
    case "task-worker":
      return taskWorkerCommand(cwd, flags);
    case "status":
      await statusCommand(cwd, flags, positionals);
      return 0;
    case "result":
      await resultCommand(cwd, flags, positionals);
      return 0;
    case "cancel":
      await cancelCommand(cwd, positionals);
      return 0;
    case "usage":
      await usageCommand(flags);
      return 0;
    case "link":
      await linkCommand();
      return 0;
    default:
      throw new Error(`unknown subcommand ${command}`);
  }
}

main()
  .then((code) => {
    process.exitCode = Number(code || 0);
  })
  .catch(async (error) => {
    const message = error?.message || String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
