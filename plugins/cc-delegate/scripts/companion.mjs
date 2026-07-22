import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { clipVisible } from "./lib/ansi.mjs";
import { parseArgs } from "./lib/args.mjs";
import {
  ENV_FILE,
  USAGE_LEDGER_FILE,
  LAST_ANALYSIS_FILE,
  LAST_ANALYSIS_META_FILE,
  loadKeys,
  maskKey,
} from "./lib/env.mjs";
import { loadConfig } from "./lib/config.mjs";
import { runTrackedJob, spawnBackgroundWorker } from "./lib/jobs.mjs";
import { PROVIDERS, callProvider } from "./lib/providers.mjs";
import { getActiveProviders, renderProviderGuide } from "./lib/providerGuide.mjs";
import { buildQuotaSection, computeQuotaStatus, currentMonthKey, formatQuotaAlertLine, formatUsd2 } from "./lib/quota.mjs";
import { terminalStyles, sectionTitle } from "./lib/styles.mjs";
import { buildHealthAdvisory, formatAdvisoryLines, listActiveAdvisories } from "./lib/advisor.mjs";
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
  return terminalStyles(process.stdout);
}

// Semantic color for "higher is better" percentages (e.g. success rate).
function colorByPercent(text, value, styles) {
  if (value >= 95) return styles.green(text);
  if (value >= 80) return styles.yellow(text);
  return styles.red(text);
}

// Semantic color for p95 latency: fine under 10s, warning under 30s, red above.
function colorByP95Latency(text, ms, styles) {
  if (ms === null || ms === undefined) return text;
  if (ms > 30000) return styles.red(text);
  if (ms > 10000) return styles.yellow(text);
  return text;
}

// Semantic color for context-window usage: green <50%, yellow 50-79%, red >=80%.
function colorByCtxPct(text, pct, styles) {
  if (pct >= 80) return styles.red(text);
  if (pct >= 50) return styles.yellow(text);
  return styles.green(text);
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
      if (!process.env.CC_DELEGATE_SESSION_ID) {
        return { sessionError: "no current session id (CC_DELEGATE_SESSION_ID not set)" };
      }
      sessionFilter = process.env.CC_DELEGATE_SESSION_ID;
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

// Width-aware: shrinks the last column (with a "…" truncation marker) so the
// row fits `maxWidth`. Headers are never truncated below their own label —
// callers should pass short header abbreviations for narrow terminals.
function renderTable(headers, rows, styles, colorRow, maxWidth = process.stdout.columns || 100) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row.cells[index]).length)),
  );
  const lastIndex = widths.length - 1;
  const fixedWidth = widths.slice(0, -1).reduce((sum, width) => sum + width, 0) + 2 * lastIndex;
  const availableForLast = Math.max(headers[lastIndex].length, maxWidth - fixedWidth);
  widths[lastIndex] = Math.min(widths[lastIndex], availableForLast);

  const pad = (cells) =>
    cells.map((cell, index) => {
      const text = String(cell);
      const width = widths[index];
      if (text.length <= width) {
        return text.padEnd(width);
      }
      if (index !== lastIndex) {
        return text.padEnd(width);
      }
      return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
    });

  const paddedHeaders = pad(headers);
  const lines = [];
  if (styles.isTTY) {
    // TTY: underline replaces the dash separator row entirely.
    lines.push(paddedHeaders.map((cell) => styles.dim(styles.underline(cell))).join("  "));
  } else {
    // Non-TTY (pipes/--static): no ANSI available, keep the plain dash separator.
    const headerLine = paddedHeaders.join("  ");
    lines.push(headerLine);
    lines.push(styles.dim("─".repeat(headerLine.length)));
  }
  for (const row of rows) {
    const padded = pad(row.cells);
    lines.push((colorRow ? colorRow(padded, row) : padded).join("  "));
  }
  return lines.join("\n");
}

// Builds the human-readable Overview body (no trailing newline). `filtered`/
// `filterInfo` come from resolveLedgerFilter; `quotaSection` from
// buildQuotaSection (or null when no quotas are configured).
function buildOverviewView(filtered, filterInfo, styles, quotaSection) {
  const { since, sessionFilter, days } = filterInfo;

  if (!filtered.length) {
    if (!quotaSection) {
      return "no usage recorded yet";
    }
    const emptySections = [`${sectionTitle("Quotas (this month)", styles)}\n${quotaSection.rows.join("\n")}`];
    if (quotaSection.alerts.length) {
      emptySections.push(quotaSection.alerts.join("\n"));
    }
    return emptySections.join("\n\n");
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
  const providerRows = formatUsageRows(displayUsage.byProvider, totalCost, styles, (name) =>
    name === "unknown" ? "(failed — no provider)" : name,
  );
  const sessionRows = formatUsageRows(displayUsage.bySession, totalCost, styles, (name) => {
    const sessionId = name === "null" ? null : name;
    const current = sessionId && sessionId === process.env.CC_DELEGATE_SESSION_ID ? " (current)" : "";
    return `${formatSessionLabel(sessionId)}${current}`;
  });

  const sections = [
    sectionTitle(`cc-delegate usage — ${scope}`, styles),
    summary.join("\n"),
    `${sectionTitle("By model", styles)}\n${modelRows.join("\n")}`,
    `${sectionTitle("By provider", styles)}\n${providerRows.join("\n")}`,
    `${sectionTitle("By session", styles)}\n${sessionRows.join("\n")}`,
  ];
  if (quotaSection) {
    sections.push(`${sectionTitle("Quotas (this month)", styles)}\n${quotaSection.rows.join("\n")}`);
  }
  if (quotaSection?.alerts.length) {
    sections.push(quotaSection.alerts.join("\n"));
  }
  sections.push(
    styles.dim(
      "views: usage --details · usage --health   filters: --days N · --model <alias> · --provider <name> · --session current",
    ),
  );
  return sections.join("\n\n");
}

// Builds the human-readable Details body (no trailing newline).
function buildDetailsView(limited, styles) {
  if (!limited.length) {
    return "no usage recorded yet";
  }

  const headers = ["TIME", "JOB", "MODEL", "PROVIDER", "IN", "OUT", "COST", "LATENCY", "CTX%", "STATUS"];
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
        entry.ctxPct === null || entry.ctxPct === undefined ? "-" : formatPercent(entry.ctxPct),
        failed ? "failed" : "completed",
      ],
      ctxPct: entry.ctxPct,
      failed,
    };
  });

  const ctxIndex = headers.indexOf("CTX%");
  return renderTable(headers, rows, styles, (cells, row) => {
    if (row.failed) {
      const dimmed = cells.map((cell) => styles.dim(cell));
      dimmed[dimmed.length - 1] = styles.red(cells[cells.length - 1]);
      return dimmed;
    }
    if (row.ctxPct === null || row.ctxPct === undefined) {
      return cells;
    }
    const colored = [...cells];
    colored[ctxIndex] = colorByCtxPct(cells[ctxIndex], row.ctxPct, styles);
    return colored;
  });
}

// Builds the human-readable Health body (no trailing newline). `advisories`
// is the array from listActiveAdvisories: [{alias, provider, advisory}].
function buildHealthView(normalized, modelStats, providerStats, warnings, styles, advisories = []) {
  if (!normalized.length) {
    return "no usage recorded yet";
  }

  const headers = ["NAME", "REQS", "OK%", "AVG", "P95", "FBACK", "$/REQ", "LAST ERR"];
  const toRows = (statRows) => statRows.map((row) => ({ cells: healthRowCells(row), raw: row }));
  const colorRow = (cells, row) => {
    const colored = [...cells];
    colored[2] = colorByPercent(cells[2], row.raw.successPct, styles);
    colored[4] = colorByP95Latency(cells[4], row.raw.p95LatencyMs, styles);
    return colored;
  };
  const modelTable = renderTable(headers, toRows(modelStats), styles, colorRow);
  const providerTable = renderTable(headers, toRows(providerStats), styles, colorRow);

  const sections = [
    `${sectionTitle("By model", styles)}\n${modelTable}`,
    `${sectionTitle("By provider", styles)}\n${providerTable}`,
  ];
  if (warnings.length) {
    sections.push(warnings.map((warning) => styles.yellow(warning)).join("\n"));
  }
  if (advisories.length) {
    const advisoryText = advisories
      .map(({ alias, provider, advisory }) => formatAdvisoryLines(alias, provider, advisory).join("\n"))
      .join("\n\n");
    sections.push(`${sectionTitle("Advisories", styles)}\n${advisoryText}`);
  }
  return sections.join("\n\n");
}

// Builds the human-readable Quotas body (no trailing newline). Used by the
// TUI's Quotas tab; the static `usage` overview embeds the same section.
function buildQuotasView(config, entries, styles) {
  const quotaSection = buildQuotaSection(config, entries, styles);
  if (!quotaSection) {
    return [
      "no quotas configured — run cc-delegate-keys to set monthly quotas",
      styles.dim("Set a monthly USD quota per provider: run `cc-delegate-keys` and answer the quota prompt."),
    ].join("\n\n");
  }
  const sections = [`${sectionTitle("Quotas (this month)", styles)}\n${quotaSection.rows.join("\n")}`];
  if (quotaSection.alerts.length) {
    sections.push(quotaSection.alerts.join("\n"));
  }
  return sections.join("\n\n");
}

const USAGE_TABS = ["Overview", "Details", "Health", "Quotas", "Analyze"];

function buildTabBar(activeIndex) {
  return USAGE_TABS.map((name, index) => (index === activeIndex ? `\x1b[7m ${name} \x1b[0m` : ` ${name} `)).join(
    "│",
  );
}

// Builds the human-readable Analyze body (no trailing newline). Static,
// informative content: it points to `/cc-delegate:analyze` (the actual AI
// analysis only runs inside Claude Code) plus a no-AI local mini-summary and
// the last analysis saved via `analysis save` (if any).
function buildAnalyzeView(entries, filtered, warnings, activeAdvisories, savedAnalysis, styles) {
  const title = sectionTitle("Analyze", styles);
  const message =
    "AI analysis runs inside Claude Code: use /cc-delegate:analyze — it dispatches a subagent (Sonnet) with your usage/details/health and returns cost recommendations, provider health, and where to save.";

  const monthKey = currentMonthKey();
  const monthCost = entries
    .filter((entry) => currentMonthKey(new Date(entry.ts)) === monthKey)
    .reduce((sum, entry) => sum + Number(entry.cost || 0), 0);

  // Top model by SPEND, not job count — job counts tie easily and mislead.
  const modelSpend = {};
  for (const entry of filtered) {
    const model = String(entry.model || "unknown");
    const bucket = (modelSpend[model] ||= { cost: 0, tokens: 0, jobs: 0 });
    bucket.cost += Number(entry.cost || 0);
    bucket.tokens += Number(entry.promptTokens || 0) + Number(entry.completionTokens || 0);
    bucket.jobs += 1;
  }
  const topModelEntry = Object.entries(modelSpend).sort(
    (left, right) =>
      right[1].cost - left[1].cost || right[1].tokens - left[1].tokens || left[0].localeCompare(right[0]),
  )[0];
  const topModel = topModelEntry
    ? `${topModelEntry[0]} (${formatUsd(topModelEntry[1].cost)}, ${topModelEntry[1].jobs} job${topModelEntry[1].jobs === 1 ? "" : "s"})`
    : "-";

  const summaryLines = [`spend this month: ${formatUsd(monthCost)}`, `top model by spend: ${topModel}`];
  if (warnings.length || activeAdvisories.length) {
    summaryLines.push("active alerts:");
    for (const warning of warnings) {
      summaryLines.push(`  ${warning}`);
    }
    for (const { alias, provider, advisory } of activeAdvisories) {
      summaryLines.push(`  ${formatAdvisoryLines(alias, provider, advisory)[0]}`);
    }
  } else {
    summaryLines.push("active alerts: none");
  }
  const summary = styles.dim(summaryLines.join("\n"));

  const analysisBlock = savedAnalysis
    ? `${styles.bold(`Last analysis — ${formatRelativeTime(savedAnalysis.savedAt)}`)}\n\n${savedAnalysis.content.trimEnd()}`
    : styles.dim("no analysis saved yet");
  const hint = styles.dim("to run a new analysis: /cc-delegate:analyze inside Claude Code");

  return [title, message, summary, analysisBlock, hint].join("\n\n");
}

function buildUsageTabBody(tabIndex, entries, flags, config, styles, models, savedAnalysis) {
  const { filtered, since, sessionFilter, days, sessionError } = resolveLedgerFilter(entries, flags);

  if (tabIndex === 3) {
    return buildQuotasView(config, entries, styles);
  }
  if (sessionError) {
    return sessionError;
  }
  if (tabIndex === 0) {
    const quotaSection = buildQuotaSection(config, entries, styles);
    return buildOverviewView(filtered, { since, sessionFilter, days }, styles, quotaSection);
  }
  if (tabIndex === 1) {
    const limit = flags.limit !== undefined && Number.isFinite(Number(flags.limit)) ? Number(flags.limit) : 20;
    const sorted = [...filtered].sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts));
    const limited = sorted.slice(0, Math.max(0, limit));
    return buildDetailsView(limited, styles);
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
  const activeAdvisories = listActiveAdvisories(normalized, models);

  if (tabIndex === 4) {
    return buildAnalyzeView(entries, filtered, warnings, activeAdvisories, savedAnalysis, styles);
  }
  return buildHealthView(normalized, modelStats, providerStats, warnings, styles, activeAdvisories);
}

// Interactive tabbed usage viewer. Entered only when stdout/stdin are both
// TTYs and no view flag (--details/--health/--json) or --static was passed.
// ponytail: no scroll — content taller than the terminal is truncated with a
// hint to use the static --details/--limit view instead of building a pager.
async function runUsageTui(flags) {
  const stdout = process.stdout;
  const stdin = process.stdin;
  const config = await loadConfig();
  const models = await readModelsRegistry();
  let entries = await readUsageLedger();
  let savedAnalysis = await readSavedAnalysis();
  let activeTab = 0;
  const wasRaw = Boolean(stdin.isRaw);
  let lastError = null;

  function render() {
    const styles = usageStyles();
    const tabBar = buildTabBar(activeTab);
    const body = buildUsageTabBody(activeTab, entries, flags, config, styles, models, savedAnalysis);
    const helpLine = styles.dim("←/→ or 1-5 switch view · r reload · q quit");

    const rows = stdout.rows || 24;
    const maxBodyLines = Math.max(1, rows - 3); // tab bar + blank line + help line
    let bodyLines = body.split("\n");
    let truncated = false;
    if (bodyLines.length > maxBodyLines) {
      bodyLines = bodyLines.slice(0, Math.max(0, maxBodyLines - 1));
      truncated = true;
    }

    const outLines = [tabBar, "", ...bodyLines];
    if (truncated) {
      outLines.push(styles.dim("… (use the static view with --details --limit N to see everything)"));
    }
    outLines.push(helpLine);
    // Hard-clip every line to the terminal width — a wrapped table row would
    // desynchronize the fixed-height layout above.
    const columns = stdout.columns || 100;
    stdout.write(`\x1b[2J\x1b[H${outLines.map((line) => clipVisible(line, columns)).join("\n")}`);
  }

  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  let exiting = false;
  function requestExit() {
    if (exiting) return;
    exiting = true;
    resolveExit();
  }

  // A raw PTY can deliver an escape sequence split across several `data`
  // events (observed: byte-by-byte under `script`). Buffer input and, on a
  // lone trailing ESC, wait briefly for the rest of the sequence before
  // treating it as a standalone Escape keypress.
  let pending = "";
  let escTimer = null;

  function clearEscTimer() {
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
  }

  async function drainPending() {
    let acted = false;
    while (pending.length) {
      const ch = pending[0];
      if (ch === "\x1b") {
        if (pending.length === 1) {
          clearEscTimer();
          escTimer = setTimeout(() => {
            escTimer = null;
            if (pending === "\x1b") {
              pending = "";
              requestExit();
            }
          }, 50);
          break;
        }
        if (pending[1] !== "[") {
          pending = pending.slice(1);
          if (acted) render();
          requestExit();
          return;
        }
        if (pending.length < 3) {
          break;
        }
        const dir = pending[2];
        pending = pending.slice(3);
        if (dir === "C") {
          activeTab = (activeTab + 1) % USAGE_TABS.length;
          acted = true;
        } else if (dir === "D") {
          activeTab = (activeTab + USAGE_TABS.length - 1) % USAGE_TABS.length;
          acted = true;
        }
        continue;
      }

      pending = pending.slice(1);
      if (ch === "q" || ch === "\x03") {
        if (acted) render();
        requestExit();
        return;
      }
      if (ch === "\t") {
        activeTab = (activeTab + 1) % USAGE_TABS.length;
        acted = true;
      } else if (ch >= "1" && ch <= "5") {
        activeTab = Number(ch) - 1;
        acted = true;
      } else if (ch === "r") {
        entries = await readUsageLedger();
        savedAnalysis = await readSavedAnalysis();
        acted = true;
      }
    }
    if (acted && !exiting) {
      render();
    }
  }

  async function onData(chunk) {
    try {
      pending += String(chunk);
      await drainPending();
    } catch (error) {
      lastError = error;
      requestExit();
    }
  }

  function onSigint() {
    requestExit();
  }

  stdout.write("\x1b[?1049h\x1b[?25l");
  stdin.setEncoding("utf8");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onData);
  process.on("SIGINT", onSigint);

  try {
    render();
    await exitPromise;
  } finally {
    clearEscTimer();
    stdin.removeListener("data", onData);
    process.removeListener("SIGINT", onSigint);
    stdin.setRawMode(wasRaw);
    stdin.pause();
    stdout.write("\x1b[?25h\x1b[?1049l");
  }

  if (lastError) {
    throw lastError;
  }
}

// Clip every line to the terminal width before printing so table rows can
// never wrap in the static (non-TUI) usage views either. No-op when stdout
// isn't a TTY — piped/redirected output keeps its full, unclipped width.
function writeClippedToStdout(text) {
  const columns = process.stdout.isTTY ? process.stdout.columns : null;
  const body = columns
    ? text
        .split("\n")
        .map((line) => clipVisible(line, columns))
        .join("\n")
    : text;
  process.stdout.write(`${body}\n`);
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

  const config = await loadConfig();

  if (flags.json) {
    const payload = {
      ...aggregateUsage(filtered),
      since: since ? since.toISOString() : null,
    };
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

  if (!flags.static && process.stdout.isTTY && process.stdin.isTTY) {
    await runUsageTui(flags);
    return;
  }

  const styles = usageStyles();
  const quotaSection = buildQuotaSection(config, entries, styles);
  const view = buildOverviewView(filtered, { since, sessionFilter, days }, styles, quotaSection);
  writeClippedToStdout(view);
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

  const styles = usageStyles();
  writeClippedToStdout(buildDetailsView(limited, styles));
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
  const models = await readModelsRegistry();
  const activeAdvisories = listActiveAdvisories(normalized, models);

  if (flags.json) {
    printJson({
      models: modelStats.map(healthRowToJson),
      providers: providerStats.map(healthRowToJson),
      warnings,
      advisories: activeAdvisories.map(({ alias, provider, advisory }) => ({ alias, provider, ...advisory })),
    });
    return;
  }

  const styles = usageStyles();
  writeClippedToStdout(buildHealthView(normalized, modelStats, providerStats, warnings, styles, activeAdvisories));
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
      timeoutMs: registryEntry.timeoutMs,
      requestParams: registryEntry.requestParams,
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

// Compact size formatter for token/context counts: "262k", "1M" — matches the
// style used in the context fail-fast/advisory messages.
function formatContextSize(value) {
  const num = Number(value || 0);
  if (num >= 1000000) {
    const millions = num / 1000000;
    const rounded = millions >= 10 ? Math.round(millions) : Number(millions.toFixed(1));
    return `${rounded}M`;
  }
  return `${Math.round(num / 1000)}k`;
}

// ponytail: chars/4 heuristic — good enough until a real tokenizer matters.
function estimatePromptTokens(messages) {
  const chars = messages.reduce((sum, message) => sum + String(message.content || "").length, 0);
  return Math.ceil(chars / 4);
}

const CONVERSATION_CHAR_LIMIT = 2_000_000;
const CONVERSATION_TAIL_KEEP = 6;
const CONVERSATION_PRUNE_MARKER = "[older turns pruned]";

// ponytail: prune by whole user+assistant pairs, oldest first, keeping the
// system message and the last CONVERSATION_TAIL_KEEP messages intact — good
// enough until real summarization-based compaction is worth the complexity.
function pruneConversation(conversation) {
  const totalChars = conversation.reduce((sum, message) => sum + String(message.content || "").length, 0);
  if (totalChars <= CONVERSATION_CHAR_LIMIT) {
    return conversation;
  }

  const hasSystem = conversation[0]?.role === "system";
  const head = hasSystem ? [conversation[0]] : [];
  const rest = hasSystem ? conversation.slice(1) : conversation;
  if (rest.length <= CONVERSATION_TAIL_KEEP) {
    return conversation; // nothing safe to prune
  }

  const tail = rest.slice(-CONVERSATION_TAIL_KEEP);
  let middle = rest.slice(0, rest.length - CONVERSATION_TAIL_KEEP);
  let pruned = false;
  const sizeOf = (msgs) => msgs.reduce((sum, message) => sum + String(message.content || "").length, 0);
  while (middle.length >= 2 && sizeOf(head) + sizeOf(middle) + sizeOf(tail) > CONVERSATION_CHAR_LIMIT) {
    middle = middle.slice(2);
    pruned = true;
  }
  if (!pruned) {
    return conversation;
  }
  // Prepend the marker to the first kept user turn instead of inserting a
  // standalone user message — a separate marker would create two consecutive
  // user turns and strict chat templates reject non-alternating roles.
  const kept = [...middle, ...tail];
  const firstUserIndex = kept.findIndex((message) => message.role === "user");
  if (firstUserIndex !== -1) {
    kept[firstUserIndex] = {
      ...kept[firstUserIndex],
      content: `${CONVERSATION_PRUNE_MARKER}\n\n${kept[firstUserIndex].content}`,
    };
  }
  return [...head, ...kept];
}

// Reconstructs the message history to resend when resuming a job: prefers the
// persisted `conversation` array; falls back to rebuilding a 3-message
// conversation from `request`/`result` for jobs completed before this field
// existed.
function getBaseConversation(job) {
  if (Array.isArray(job.conversation) && job.conversation.length) {
    return job.conversation;
  }
  if (job.request && job.result?.content) {
    return [
      { role: "system", content: job.request.system || DEFAULT_SYSTEM },
      { role: "user", content: job.request.prompt },
      { role: "assistant", content: job.result.content },
    ];
  }
  throw new Error(`job ${job.id} has no conversation to resume`);
}

// Resolves the base job for `task --resume`. "last" means the most recently
// updated COMPLETED job — a background job still running must not shadow the
// previous resumable thread. An explicit id accepts an exact id or an
// unambiguous prefix; a failed/cancelled match is a clear error.
async function resolveResumeJob(cwd, resumeArg) {
  let job;
  if (resumeArg === "last") {
    const jobs = await listJobs(cwd);
    const lastCompleted = jobs.find((entry) => entry.status === "completed");
    job = lastCompleted ? await loadJob(cwd, lastCompleted.id) : null;
    if (!job) {
      throw new Error("no completed job to resume in this workspace");
    }
  } else {
    job = await loadJob(cwd, resumeArg);
    if (!job) {
      const jobs = await listJobs(cwd);
      const matches = jobs.filter((entry) => entry.id.startsWith(resumeArg));
      if (matches.length === 1) {
        job = await loadJob(cwd, matches[0].id);
      } else if (matches.length > 1) {
        throw new Error(`job id "${resumeArg}" is ambiguous — matches ${matches.length} jobs`);
      }
    }
  }
  if (!job) {
    throw new Error(`job ${resumeArg} not found`);
  }
  if (job.status !== "completed") {
    throw new Error(`cannot resume a ${job.status} job`);
  }
  return job;
}

// Other registry models with a bigger context window than `currentAlias`,
// able to actually fit `promptTokens` — quality >= current first, then the
// rest, each group sorted by quality desc then context desc.
function suggestLargerContextModels(models, currentAlias, promptTokens) {
  const current = models[currentAlias] || {};
  const currentContext = Number(current.context || 0);
  const currentQuality = Number(current.quality ?? 0);

  const candidates = Object.entries(models)
    .filter(([alias, model]) => alias !== currentAlias && model.context > currentContext && model.context >= promptTokens)
    .map(([alias, model]) => ({ alias, context: model.context, quality: Number(model.quality ?? 0) }));

  const bySort = (left, right) => right.quality - left.quality || right.context - left.context;
  const higherQuality = candidates.filter((candidate) => candidate.quality >= currentQuality).sort(bySort);
  const rest = candidates.filter((candidate) => candidate.quality < currentQuality).sort(bySort);
  return [...higherQuality, ...rest];
}

// Pre-flight context-window check: fails fast (before any provider/key check)
// when the prompt clearly can't fit, otherwise returns a non-blocking
// advisory line once usage crosses 70% of the model's context.
function evaluateContextWindow(models, alias, messages) {
  const model = models[alias];
  const promptTokens = estimatePromptTokens(messages);
  if (!model?.context) {
    return { promptTokens, ctxPct: null, exceeded: false, advisoryLine: null };
  }

  const context = model.context;
  const pct = Math.round((promptTokens / context) * 100);

  if (promptTokens > context) {
    const suggestions = suggestLargerContextModels(models, alias, promptTokens);
    const suggestionText = suggestions.length
      ? suggestions.map((s) => `${s.alias} ${formatContextSize(s.context)}`).join(", ")
      : "none in the registry";
    return {
      promptTokens,
      ctxPct: pct,
      exceeded: true,
      failMessage: `prompt ~${formatContextSize(promptTokens)} tokens exceeds ${alias}'s context window (${formatContextSize(context)}). Models with larger windows: ${suggestionText}.`,
    };
  }

  let advisoryLine = null;
  if (pct >= 70) {
    const suggestions = suggestLargerContextModels(models, alias, promptTokens).slice(0, 2);
    const sameContext = suggestions.length === 2 && suggestions[0].context === suggestions[1].context;
    const suggestionText = !suggestions.length
      ? "no model with a larger window in the registry"
      : sameContext
        ? `for prompts this size consider ${suggestions.map((s) => s.alias).join("/")} (${formatContextSize(suggestions[0].context)})`
        : `for prompts this size consider ${suggestions.map((s) => `${s.alias} (${formatContextSize(s.context)})`).join(", ")}`;
    advisoryLine = `⚠ context: ~${formatContextSize(promptTokens)} of ${formatContextSize(context)} (${pct}%) on ${alias} — ${suggestionText}`;
  }
  return { promptTokens, ctxPct: pct, exceeded: false, advisoryLine };
}

async function executeTaskRequest(job, models, request, tools) {
  const selection = resolveModelSelection(models, request.model, request.provider);
  const hasConversationSeed = Array.isArray(request.conversationSeed) && request.conversationSeed.length > 0;
  const messages = hasConversationSeed
    ? [...request.conversationSeed, { role: "user", content: request.prompt }]
    : [
        { role: "system", content: request.system || DEFAULT_SYSTEM },
        { role: "user", content: request.prompt },
      ];

  if (hasConversationSeed) {
    await tools.log(
      `resuming from ${job.resumedFrom}: ${messages.length} messages carried into this request (${request.conversationSeed.length} prior + 1 new user turn)`,
    );
  }

  // Context-window guard runs before any provider/key check — a prompt that
  // can't fit is a fast, clean failure regardless of what keys are configured.
  // Note: `messages` is the FULL re-sent conversation on a resume, so the
  // guard measures the whole thread, not just the new turn.
  const contextGuard = evaluateContextWindow(models, selection.alias, messages);
  await tools.setJob({ ctxPct: contextGuard.ctxPct });
  if (contextGuard.exceeded) {
    await tools.setJob({ contextExceeded: true });
    throw new Error(contextGuard.failMessage);
  }

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
        timeoutMs: selection.timeoutMs,
        maxTokens: request.maxTokens,
        requestParams: selection.requestParams,
      });
      const latencyMs = Date.now() - callStartedAt;
      if (!response.usage) {
        await tools.log(`usage not reported by provider ${candidate.name}`);
      }
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
      // ponytail: text-only history — no tool calls in the persisted conversation.
      const conversation = pruneConversation([...messages, { role: "assistant", content }]);
      return {
        provider: candidate.name,
        attempts,
        usage,
        cost,
        latencyMs,
        ctxPct: contextGuard.ctxPct,
        contextAdvisory: contextGuard.advisoryLine,
        conversation,
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
        `Configure keys: in Claude Code type \`! cc-delegate-keys\`, or run in your terminal:\n` +
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
    resumedFrom: job.resumedFrom ?? null,
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
  const models = await readModelsRegistry();
  const activeProviders = new Set(getActiveProviders(models));
  for (const [provider, data] of Object.entries(payload.providers)) {
    data.active = activeProviders.has(provider);
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
    // Inactive providers (no model routes) only show up if a key is stored.
    if (!data.active && !data.keyPresent) {
      continue;
    }
    let line = `${provider}: ${data.keyHint || "missing"}`;
    if (!data.active) {
      line += " (inactive — no model routes)";
    }
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
    const styles = usageStyles();
    process.stdout.write(`${renderProviderGuide(models, styles, process.stdout.columns || 100)}\n`);
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

  let model = String(flags.model || "qwen");
  let resumedFrom = null;
  let conversationSeed = null;
  let modelMismatchWarning = null;

  if (flags.resume !== undefined) {
    const resumeArg = String(flags.resume);
    const baseJob = await resolveResumeJob(cwd, resumeArg);
    resumedFrom = baseJob.id;
    const explicitModel = typeof flags.model === "string" && flags.model !== baseJob.model;
    if (explicitModel) {
      model = String(flags.model);
      modelMismatchWarning =
        `--model ${model} differs from base job ${baseJob.id}'s model ${baseJob.model} — resuming without history`;
    } else {
      model = baseJob.model;
      conversationSeed = getBaseConversation(baseJob);
    }
  }

  const request = {
    model,
    provider: typeof flags.provider === "string" ? flags.provider : null,
    system: typeof flags.system === "string" ? flags.system : DEFAULT_SYSTEM,
    maxTokens: flags["max-tokens"] !== undefined ? Number(flags["max-tokens"]) : undefined,
    prompt: userPrompt,
    conversationSeed,
  };

  const job = await createJob(cwd, {
    cwd,
    command: "task",
    model: request.model,
    promptPreview: prompt.slice(0, 140),
    request,
    resumedFrom,
  });

  if (modelMismatchWarning) {
    await appendJobLog(cwd, job.id, modelMismatchWarning);
  }

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

// Non-blocking, same contract as attachQuotaAlert: never turns a completed
// task into an apparent failure, and it also runs after a failed task (using
// the last attempted provider) so the failure itself can be contextualized.
async function attachHealthAdvisory(cwd, job) {
  try {
    let alias = null;
    let provider = null;
    if (job.status === "completed" && job.provider) {
      alias = job.result?.alias || job.model;
      provider = job.provider;
    } else if (job.status === "failed" && Array.isArray(job.attempts) && job.attempts.length) {
      const lastAttempted = [...job.attempts].reverse().find((attempt) => attempt.provider);
      alias = job.model;
      provider = lastAttempted?.provider || null;
    }
    if (!alias || !provider) {
      return job;
    }

    const models = await readModelsRegistry();
    const entries = await readUsageLedger();
    const advisory = buildHealthAdvisory({ alias, provider, entries, models });
    if (!advisory) {
      return job;
    }
    const advisoryAlert = formatAdvisoryLines(alias, provider, advisory);
    await appendJobLog(cwd, job.id, advisoryAlert[0]);
    return await updateJob(cwd, job.id, { advisory, advisoryAlert });
  } catch {
    return job;
  }
}

// Shared by taskCommand/resultCommand: context advisory first (immediate to
// this run), then circuit-breaker advisory, then quota alert.
function buildAlertPrefix(job) {
  const lines = [
    ...(job.contextAdvisory ? [job.contextAdvisory] : []),
    ...(job.advisoryAlert || []),
    ...(job.quotaAlert || []),
  ];
  return lines.length ? `${lines.join("\n")}\n\n` : "";
}

async function runTask(cwd, job) {
  await loadKeys();
  const models = await readModelsRegistry();
  const completed = await runTrackedJob(cwd, job.id, async (tools) => {
    const outcome = await executeTaskRequest(job, models, job.request, tools);
    return outcome;
  });
  const withQuota = await attachQuotaAlert(cwd, completed);
  return attachHealthAdvisory(cwd, withQuota);
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
    process.stdout.write(`${buildAlertPrefix(completed)}${completed.result?.content || ""}\n`);
  } else {
    process.stderr.write(`${buildAlertPrefix(completed)}${jobErrorMessage(completed)}\n`);
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
    if (payload.resumedFrom) {
      lines.push(`resumed from ${payload.resumedFrom}`);
    }
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
    const resumedSuffix = job.resumedFrom ? ` (resumed from ${job.resumedFrom})` : "";
    lines.push(`${job.id} ${job.status} elapsed=${job.elapsedMs}ms${resumedSuffix}`);
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
    advisory: job.advisory || null,
    contextAdvisory: job.contextAdvisory || null,
    resumedFrom: job.resumedFrom || null,
  };

  if (flags.json) {
    printJson(payload);
    return;
  }

  const alertPrefix = buildAlertPrefix(job);
  const resumedLine = payload.resumedFrom ? `resumed from ${payload.resumedFrom}\n` : "";

  if (payload.output) {
    process.stdout.write(`${resumedLine}${alertPrefix}${payload.output}\n`);
    return;
  }

  process.stdout.write(`${resumedLine}${alertPrefix}${payload.error || "no output stored"}\n`);
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
    { name: "cc-delegate", rel: "scripts/companion.mjs" },
    { name: "cc-delegate-keys", rel: "scripts/setup-keys.mjs" },
  ];
  for (const wrapper of wrappers) {
    // Semver-sort the installed version dirs; mtime is unreliable because
    // running sessions touch old version dirs via .in_use locks.
    const body = isVersionedInstall
      ? `#!/bin/sh\nVER="$(ls "${versionsRoot}" 2>/dev/null | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"\nexec node "${versionsRoot}/\${VER}/${wrapper.rel}" "$@"\n`
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

async function readStdinText() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}

// Reads the last analysis saved via `analysis save`, or null if none exists.
async function readSavedAnalysis() {
  try {
    const content = await fs.readFile(LAST_ANALYSIS_FILE, "utf8");
    let meta = {};
    try {
      meta = JSON.parse(await fs.readFile(LAST_ANALYSIS_META_FILE, "utf8"));
    } catch {
      // ponytail: missing/corrupt sidecar just means unknown savedAt/sessionId
    }
    return { content, savedAt: meta.savedAt || null, sessionId: meta.sessionId ?? null };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function analysisSaveCommand() {
  const content = await readStdinText();
  await fs.mkdir(path.dirname(LAST_ANALYSIS_FILE), { recursive: true });
  await fs.writeFile(LAST_ANALYSIS_FILE, content, "utf8");
  const meta = { savedAt: new Date().toISOString(), sessionId: process.env.CC_DELEGATE_SESSION_ID || null };
  await fs.writeFile(LAST_ANALYSIS_META_FILE, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  process.stdout.write("saved\n");
}

async function analysisShowCommand(flags) {
  const saved = await readSavedAnalysis();

  if (flags.json) {
    printJson(saved ? { savedAt: saved.savedAt, sessionId: saved.sessionId, content: saved.content } : { savedAt: null, sessionId: null, content: null });
    return;
  }

  if (!saved) {
    process.stdout.write("no analysis saved yet\n");
    return;
  }

  const relative = saved.savedAt ? formatRelativeTime(saved.savedAt) : "unknown time";
  process.stdout.write(`Last analysis — ${relative}\n\n${saved.content}\n`);
}

async function analysisCommand(flags, positionals) {
  const sub = positionals[0];
  if (sub === "save") {
    await analysisSaveCommand();
    return;
  }
  if (sub === "show") {
    await analysisShowCommand(flags);
    return;
  }
  throw new Error("analysis requires a subcommand: save, show");
}

async function main() {
  const { command, cwd, flags, positionals } = parseArgs();

  if (!command) {
    throw new Error(
      "subcommand required: setup, models, task, task-worker, status, result, cancel, usage, analysis, link",
    );
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
    case "analysis":
      await analysisCommand(flags, positionals);
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
