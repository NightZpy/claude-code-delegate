import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline/promises";
import { stdin as procStdin, stdout as procStdout } from "node:process";
import { fileURLToPath } from "node:url";
import { clipVisible } from "./lib/ansi.mjs";
import { parseArgs } from "./lib/args.mjs";
import {
  ENV_FILE,
  USAGE_LEDGER_FILE,
  LAST_ANALYSIS_FILE,
  LAST_ANALYSIS_META_FILE,
  CC_DELEGATE_HOME,
  loadKeys,
  maskKey,
} from "./lib/env.mjs";
import { loadConfig, saveConfig } from "./lib/config.mjs";
import { runTrackedJob, spawnBackgroundWorker, appendUsageLedger } from "./lib/jobs.mjs";
import { runAgenticWorkersParallel } from "./lib/agentic-parallel.mjs";
import { diffOfFiles, reconcileClaims } from "./lib/write-verify.mjs";
import {
  checkServerHealth,
  ensureLeanAgents,
  acquireAgenticSlot,
  readAgenticSlotHolder,
  listMessages,
  summarizeActivity,
  sumSessionUsage,
  createSession,
  ensureServer,
  extractText,
  getOpencodeVersion,
  isOpencodeInstalled,
  makeBasicAuth,
  readServerState,
  sendMessage,
  stopServer,
} from "./lib/opencode.mjs";
import { PROVIDERS, callProvider, fetchOpenRouterCredits, fetchProviderBalance, fetchSiliconFlowBalance } from "./lib/providers.mjs";
import { createIsolatedWorktree, captureJobPatch, mergePatchBack } from "./lib/worktree.mjs";
import { runOrchestration } from "./lib/orchestrate.mjs";
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
  jobLogFilePath,
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
  // Cached input tokens are billed at ~10% of the fresh input rate (providers
  // bill them as a separate line item). Use the model's cachedInput rate when
  // the provider reports cached_tokens; otherwise everything is fresh input.
  const cachedRate = pricing.cachedInput !== undefined ? Number(pricing.cachedInput) : input;
  const prompt = Number(usage.prompt_tokens || 0);
  const cached = Number(usage.prompt_tokens_details?.cached_tokens || usage.cached_tokens || 0);
  const fresh = Math.max(0, prompt - cached);
  const promptCost = (fresh / 1000000) * input + (cached / 1000000) * cachedRate;
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
  const modeFilter = typeof flags.mode === "string" ? flags.mode : null;
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
    if (modeFilter) {
      const entryMode = entry.mode || "text";
      if (entryMode !== modeFilter) {
        return false;
      }
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

  const agenticEntries = filtered.filter((entry) => (entry.mode || "text") === "agentic");
  let agenticLine = null;
  if (agenticEntries.length > 0) {
    const agenticCost = agenticEntries.reduce((sum, entry) => sum + Number(entry.cost || 0), 0);
    const textEntries = filtered.filter((entry) => (entry.mode || "text") === "text");
    const textCost = textEntries.reduce((sum, entry) => sum + Number(entry.cost || 0), 0);
    agenticLine = `  ${styles.dim("agentic spend:")} ${formatUsd(agenticCost)} across ${agenticEntries.length} call${agenticEntries.length === 1 ? "" : "s"} (text: ${formatUsd(textCost)} / ${textEntries.length} calls)`;
  }

  const sections = [
    sectionTitle(`cc-delegate usage — ${scope}`, styles),
    summary.join("\n"),
    ...(agenticLine ? [agenticLine] : []),
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
function buildDetailsView(limited, styles, runningJobs = []) {
  if (!limited.length && !(runningJobs && runningJobs.length)) {
    return "no usage recorded yet";
  }

  const headers = ["TIME", "JOB", "MODEL", "PROVIDER", "IN", "OUT", "COST", "LATENCY", "CTX%", "STATUS", "MODE"];
  // Running jobs first (STATUS col is index 9; MODE is last). Build explicitly
  // so the STATUS/MODE placement matches this view's columns.
  const runningRows = (runningJobs || []).map((j) => {
    const cells = ["-", "-", "-", "-", "-", "-", "-", "-", "-", "-", "-"];
    cells[0] = formatRelativeTime(j.startedAt);
    cells[1] = formatJobIdShort(j.jobId);
    cells[2] = String(j.model || "-");
    cells[3] = String(j.provider || "-");
    cells[7] = "running";
    cells[9] = j.status || "running";
    cells[10] = j.mode || "text";
    return { cells, running: true, ctxPct: null, failed: false };
  });
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
        entry.mode || "text",
      ],
      ctxPct: entry.ctxPct,
      failed,
    };
  });

  const ctxIndex = headers.indexOf("CTX%");
  const statusIndex = headers.indexOf("STATUS");
  return renderTable(headers, [...runningRows, ...rows], styles, (cells, row) => {
    if (row.running) {
      const c = [...cells];
      c[statusIndex] = styles.bold(cells[statusIndex]);
      return c;
    }
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
function buildHealthView(normalized, modelStats, providerStats, warnings, styles, advisories = [], agenticModelStats = null, agenticProviderStats = null) {
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

  const sections = [];

  // Text-only tables (or all if no agentic data)
  const modelTitle = agenticModelStats ? "By model (text)" : "By model";
  const providerTitle = agenticProviderStats ? "By provider (text)" : "By provider";
  const modelTable = renderTable(headers, toRows(modelStats), styles, colorRow);
  const providerTable = renderTable(headers, toRows(providerStats), styles, colorRow);
  sections.push(`${sectionTitle(modelTitle, styles)}\n${modelTable}`);
  sections.push(`${sectionTitle(providerTitle, styles)}\n${providerTable}`);

  if (agenticModelStats && agenticModelStats.length > 0) {
    const agenticModelTable = renderTable(headers, toRows(agenticModelStats), styles, colorRow);
    sections.push(`${sectionTitle("By model (agentic)", styles)}\n${agenticModelTable}`);
  }
  if (agenticProviderStats && agenticProviderStats.length > 0) {
    const agenticProviderTable = renderTable(headers, toRows(agenticProviderStats), styles, colorRow);
    sections.push(`${sectionTitle("By provider (agentic)", styles)}\n${agenticProviderTable}`);
  }

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

  const monthKey = currentMonthKey();
  const monthEntries = entries.filter(entry => currentMonthKey(new Date(entry.ts)) === monthKey);
  const providers = Object.keys(config.quotas || {});
  const rowsWithSplit = [];
  for (const row of quotaSection.rows) {
    rowsWithSplit.push(row);
    const provider = providers.find(p => row.startsWith(`${p}:`));
    if (provider) {
      const agenticCost = monthEntries
        .filter(e => e.provider === provider && (e.mode || "text") === "agentic")
        .reduce((sum, e) => sum + Number(e.cost || 0), 0);
      if (agenticCost > 0) {
        const textCost = monthEntries
          .filter(e => e.provider === provider && (e.mode || "text") === "text")
          .reduce((sum, e) => sum + Number(e.cost || 0), 0);
        rowsWithSplit.push(
          `  ${styles.dim(`text ${formatUsd(textCost)} · agentic ${formatUsd(agenticCost)} this month`)}`
        );
      }
    }
  }

  const sections = [`${sectionTitle("Quotas (this month)", styles)}\n${rowsWithSplit.join("\n")}`];
  if (quotaSection.alerts.length) {
    sections.push(quotaSection.alerts.join("\n"));
  }
  return sections.join("\n\n");
}


const USAGE_TABS = ["Overview", "Details", "Health", "Quotas", "Analyze"];

function buildTabBar(activeIndex, modeScope = "all") {
  const names = USAGE_TABS.map((name, index) => {
    const display = index === activeIndex ? `\x1b[7m ${name} \x1b[0m` : ` ${name} `;
    return display;
  });
  return names.join("│");
}

// Prominent mode-scope selector rendered as its own header line.
function buildModeBadge(modeScope, styles) {
  const opts = ["all", "text", "agentic"];
  const cells = opts.map((opt) =>
    opt === modeScope ? styles.cyan(`\x1b[7m ${opt} \x1b[0m`) : styles.dim(` ${opt} `),
  );
  return `${styles.dim("mode:")} ${cells.join(styles.dim("·"))}`;
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

  // Top model by spend
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

  // byMode split for this month (all entries)
  const textCost = entries
    .filter(e => currentMonthKey(new Date(e.ts)) === monthKey && (e.mode || "text") === "text")
    .reduce((sum, e) => sum + Number(e.cost || 0), 0);
  const agenticCost = entries
    .filter(e => currentMonthKey(new Date(e.ts)) === monthKey && (e.mode || "text") === "agentic")
    .reduce((sum, e) => sum + Number(e.cost || 0), 0);
  const byModeLine = `by mode: text ${formatUsd(textCost)} · agentic ${formatUsd(agenticCost)} this month`;

  const summaryLines = [
    `spend this month: ${formatUsd(monthCost)}`,
    byModeLine,
    `top model by spend: ${topModel}`,
  ];
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


// buildUsageTabBody
function buildUsageTabBody(tabIndex, entries, flags, config, styles, models, savedAnalysis, modeScope = 'all', runningJobs = []) {
  // Filter running jobs to the active scope BEFORE the empty-state guard, else
  // an agentic job running under a `text` scope suppresses "no text delegations yet".
  const scopedRunning = modeScope === "all"
    ? (runningJobs || [])
    : (runningJobs || []).filter((j) => (j.mode || "text") === modeScope);
  if (modeScope !== "all" && entries.length === 0 && scopedRunning.length === 0) {
    return `  ${styles.dim(`no ${modeScope} delegations yet`)}`;
  }
  if (tabIndex === 3) {
    // Quotas tab: use the already filtered entries
    return buildQuotasView(config, entries, styles);
  }

  // Overview
  if (tabIndex === 0) {
    const quotaSection = buildQuotaSection(config, entries, styles);
    return buildOverviewView(
      entries,
      { since: null, sessionFilter: null, days: null },
      styles,
      quotaSection
    );
  }

  // Details
  if (tabIndex === 1) {
    const limit =
      flags.limit !== undefined && Number.isFinite(Number(flags.limit))
        ? Number(flags.limit)
        : 20;
    const sorted = [...entries].sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts));
    const limited = sorted.slice(0, Math.max(0, limit));
    if (modeScope === "agentic") {
      return buildAgenticDetailsView(limited, styles, scopedRunning);
    }
    return buildDetailsView(limited, styles, scopedRunning);
  }

  const normalized = entries.map(normalizeLedgerEntry);
  const hasAgentic = normalized.some((e) => (e.mode || "text") === "agentic");

  let modelStats, providerStats;
  let agenticModelStats = null,
    agenticProviderStats = null;

  if (hasAgentic) {
    const textNormalized = normalized.filter((e) => (e.mode || "text") === "text");
    const agenticNormalized = normalized.filter((e) => (e.mode || "text") === "agentic");

    const textModelNames = [
      ...new Set(textNormalized.map((entry) => String(entry.model || "unknown"))),
    ].sort();
    const textProviderNames = new Set();
    for (const entry of textNormalized) {
      if (entry.status === "completed" && entry.provider)
        textProviderNames.add(entry.provider);
      for (const fp of entry.failedProviders) textProviderNames.add(fp);
    }
    const textProviderArr = [...textProviderNames].sort();

    modelStats = computeGroupStats(
      textNormalized,
      textModelNames,
      (entry) => String(entry.model || "unknown")
    );
    providerStats = computeProviderStats(textNormalized, textProviderArr);

    const agenticModelNames = [
      ...new Set(agenticNormalized.map((entry) => String(entry.model || "unknown"))),
    ].sort();
    const agenticProviderNames = new Set();
    for (const entry of agenticNormalized) {
      if (entry.status === "completed" && entry.provider)
        agenticProviderNames.add(entry.provider);
      for (const fp of entry.failedProviders) agenticProviderNames.add(fp);
    }
    const agenticProviderArr = [...agenticProviderNames].sort();

    agenticModelStats = computeGroupStats(
      agenticNormalized,
      agenticModelNames,
      (entry) => String(entry.model || "unknown")
    );
    agenticProviderStats = computeProviderStats(agenticNormalized, agenticProviderArr);
  } else {
    const modelNames = [
      ...new Set(normalized.map((entry) => String(entry.model || "unknown"))),
    ].sort();
    const providerNamesFromLedger = new Set();
    for (const entry of normalized) {
      if (entry.status === "completed" && entry.provider)
        providerNamesFromLedger.add(entry.provider);
      for (const fp of entry.failedProviders) providerNamesFromLedger.add(fp);
    }
    const providerNames = [...providerNamesFromLedger].sort();
    modelStats = computeGroupStats(
      normalized,
      modelNames,
      (entry) => String(entry.model || "unknown")
    );
    providerStats = computeProviderStats(normalized, providerNames);
  }

  const warnings = [
    ...buildHealthWarnings(modelStats, "investigate before relying on it further"),
    ...buildHealthWarnings(providerStats, "consider demoting it in models.json"),
  ];
  const activeAdvisories = listActiveAdvisories(normalized, models);

  if (tabIndex === 4) {
    // Analyze: operate on the filtered subset
    return buildAnalyzeView(entries, entries, warnings, activeAdvisories, savedAnalysis, styles);
  }
  // Health
  return buildHealthView(
    normalized,
    modelStats,
    providerStats,
    warnings,
    styles,
    activeAdvisories,
    agenticModelStats,
    agenticProviderStats
  );
}



// Interactive tabbed usage viewer. Entered only when stdout/stdin are both
// TTYs and no view flag (--details/--health/--json) or --static was passed.
// ponytail: no scroll — content taller than the terminal is truncated with a
// hint to use the static --details/--limit view instead of building a pager.
// Interactive tabbed usage viewer. Entered only when stdout/stdin are both
// TTYs and no view flag (--details/--health/--json) or --static was passed.
// ponytail: no scroll — content taller than the terminal is truncated with a
// In-flight jobs for the current workspace — they live in job state, never in
// the ledger (which only records finished jobs), so the Details tab must fetch
// them separately or running work is invisible.
async function loadRunningJobsForTui() {
  try {
    const cwd = process.cwd();
    const summaries = (await listJobs(cwd)).filter(
      (j) => j.status === "running" || j.status === "queued",
    );
    // Summaries drop `mode`/`request`; load the full job (few of them) so the
    // mode column and text/agentic scope filter are correct.
    const full = await Promise.all(summaries.map((s) => loadJob(cwd, s.id).catch(() => null)));
    return full.filter(Boolean).map((j) => ({
      jobId: j.id,
      model: j.model,
      provider: j.provider,
      mode: j.mode || (j.request?.agentic ? "agentic" : "text"),
      status: j.status,
      startedAt: j.createdAt,
    }));
  } catch {
    return [];
  }
}

// hint to use the static --details/--limit view instead of building a pager.
// runUsageTui
async function runUsageTui(flags) {
  const stdout = process.stdout;
  const stdin = process.stdin;
  const config = await loadConfig();
  const models = await readModelsRegistry();
  let entries = await readUsageLedger();
  let savedAnalysis = await readSavedAnalysis();
  let runningJobs = await loadRunningJobsForTui();
  let activeTab = 0;
  let modeScope = "all"; // all | text | agentic
  const wasRaw = Boolean(stdin.isRaw);
  let lastError = null;

  function filterEntriesByModeScope(allEntries, scope) {
    if (scope === "all") return allEntries;
    if (scope === "agentic") {
      return allEntries.filter((e) => (e.mode || "text") === "agentic");
    }
    // text
    return allEntries.filter((e) => (e.mode || "text") !== "agentic");
  }

  function render() {
    const styles = usageStyles();
    const scopedEntries = filterEntriesByModeScope(entries, modeScope);
    const tabBar = buildTabBar(activeTab, modeScope);
    const body = buildUsageTabBody(
      activeTab,
      scopedEntries,
      flags,
      config,
      styles,
      models,
      savedAnalysis,
      modeScope,
      runningJobs
    );
    const helpLine = styles.dim(
      "←/→ or 1-5 switch view · r reload · g mode (all→text→agentic) · q quit"
    );

    const rows = stdout.rows || 24;
    const maxBodyLines = Math.max(1, rows - 5); // tab bar + mode badge + blank + help + info
    let bodyLines = body.split("\n");
    let truncated = false;
    if (bodyLines.length > maxBodyLines) {
      bodyLines = bodyLines.slice(0, Math.max(0, maxBodyLines - 1));
      truncated = true;
    }

    const modeBadge = buildModeBadge(modeScope, styles);
    const outLines = [tabBar, modeBadge, "", ...bodyLines];
    if (truncated) {
      outLines.push(
        styles.dim("… (use the static view with --details --limit N to see everything)")
      );
    }
    outLines.push(helpLine);
    const homeShort = CC_DELEGATE_HOME.replace(os.homedir(), "~");
    outLines.push(
      styles.dim(`reset: cc-delegate usage --reset  ·  history + CSV exports live in ${homeShort}/`)
    );
    const columns = stdout.columns || 100;
    stdout.write(
      `\x1b[2J\x1b[H${outLines.map((line) => clipVisible(line, columns)).join("\n")}`
    );
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
        runningJobs = await loadRunningJobsForTui();
        savedAnalysis = await readSavedAnalysis();
        acted = true;
      } else if (ch === "g") {
        if (modeScope === "all") {
          modeScope = "text";
        } else if (modeScope === "text") {
          modeScope = "agentic";
        } else {
          modeScope = "all";
        }
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
  if (flags.reset) {
    let existing = [];
    try {
      existing = await readUsageLedger();
    } catch {
      // ignore
    }
    if (!existing.length) {
      process.stdout.write("no usage history to reset — nothing recorded yet.\n");
      return;
    }
    const totalCost = existing.reduce((sum, r) => sum + Number(r.cost || 0), 0);

    const toCsv = () => {
      const cols = ["ts", "provider", "model", "mode", "promptTokens", "completionTokens", "cost", "status", "latencyMs", "sessionId", "jobId"];
      const esc = (v) => {
        const s = v === undefined || v === null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [cols.join(",")];
      for (const r of existing) lines.push(cols.map((k) => esc(r[k])).join(","));
      return lines.join("\n") + "\n";
    };
    const writeCsv = async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const out = path.join(path.dirname(USAGE_LEDGER_FILE), `usage-export-${stamp}.csv`);
      await fs.writeFile(out, toCsv(), "utf8");
      return out;
    };

    // Interactive: ask whether to export first, then clear. Ctrl-C cancels.
    if (procStdin.isTTY && procStdout.isTTY && !flags.yes) {
      process.stdout.write(`Reset will clear all ${existing.length} usage rows (recorded total $${totalCost.toFixed(4)}).\n`);
      const rl = readline.createInterface({ input: procStdin, output: procStdout });
      const ans = (await rl.question("Export the current history to CSV first? [y/N]: ")).trim().toLowerCase();
      rl.close();
      if (ans === "y" || ans === "yes") {
        const out = await writeCsv();
        process.stdout.write(`exported to ${out}\n`);
      }
      await fs.rm(USAGE_LEDGER_FILE, { force: true });
      process.stdout.write("usage history cleared — the dashboard now starts fresh.\n");
      return;
    }
    // Non-interactive: require --yes; --export writes the CSV first.
    if (!flags.yes) {
      process.stdout.write(`Reset will clear all ${existing.length} usage rows ($${totalCost.toFixed(4)}). Re-run with --yes (add --export to save a CSV first): cc-delegate usage --reset --yes [--export]\n`);
      return;
    }
    if (flags.export) {
      const out = await writeCsv();
      process.stdout.write(`exported to ${out}\n`);
    }
    await fs.rm(USAGE_LEDGER_FILE, { force: true });
    process.stdout.write("usage history cleared — the dashboard now starts fresh.\n");
    return;
  }
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
  const byMode = { text: { jobs: 0, cost: 0 }, agentic: { jobs: 0, cost: 0 } };
  for (const entry of filtered) {
    const bucket = (entry.mode || "text") === "agentic" ? byMode.agentic : byMode.text;
    bucket.jobs += 1;
    bucket.cost += Number(entry.cost || 0);
  }
  byMode.text.cost = Number(byMode.text.cost.toFixed(6));
  byMode.agentic.cost = Number(byMode.agentic.cost.toFixed(6));

    const payload = {
      ...aggregateUsage(filtered),
      since: since ? since.toISOString() : null,
    };
    payload.byMode = byMode;
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

function buildAgenticDetailsView(limited, styles, runningJobs = []) {
  if (!limited.length && !(runningJobs && runningJobs.length)) {
    return "no agentic usage recorded yet";
  }

  const headers = ["TIME", "JOB", "MODEL", "AGENT", "IN", "REASON", "OUT", "CACHE-R", "TOOLS", "FILES", "COST", "LATENCY", "STATUS"];
  const runningRows = (runningJobs || []).map((j) => {
    const cells = new Array(headers.length).fill("-");
    cells[0] = formatRelativeTime(j.startedAt);
    cells[1] = formatJobIdShort(j.jobId);
    cells[2] = String(j.model || "-");
    cells[headers.length - 2] = "running";      // LATENCY
    cells[headers.length - 1] = j.status || "running"; // STATUS
    return { cells, running: true, ctxPct: null, failed: false };
  });
  const rows = limited.map((raw) => {
    const entry = normalizeLedgerEntry(raw);
    const failed = entry.status !== "completed";
    const agent = entry.agent || "-";
    const reasoning = entry.reasoningTokens ? formatCompactNumber(entry.reasoningTokens) : "-";
    const cacheRead = entry.cacheRead ? formatCompactNumber(entry.cacheRead) : "-";
    const tools = entry.toolCalls !== undefined ? entry.toolCalls : "-";
    const touchedText =
      entry.touchedCount === null || entry.touchedCount === undefined ? "-" : entry.touchedCount;
    const row = {
      cells: [
        formatRelativeTime(entry.ts),
        formatJobIdShort(entry.jobId),
        String(entry.model || "-"),
        agent,
        formatCompactNumber(entry.promptTokens),
        reasoning,
        formatCompactNumber(entry.completionTokens),
        cacheRead,
        String(tools),
        String(touchedText),
        formatUsd(entry.cost),
        formatLatency(entry.latencyMs),
        failed ? "failed" : "completed",
      ],
      ctxPct: entry.ctxPct,
      failed,
    };
    return row;
  });

  return renderTable(headers, [...runningRows, ...rows], styles, (cells, row) => {
    if (row.running) {
      const c = [...cells];
      c[c.length - 1] = styles.bold(cells[cells.length - 1]);
      return c;
    }
    if (row.failed) {
      const dimmed = cells.map((cell) => styles.dim(cell));
      dimmed[dimmed.length - 1] = styles.red(cells[cells.length - 1]);
      return dimmed;
    }
    // No context-percentage column, so no coloring needed.
    return cells;
  });
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
  if (flags.mode === "agentic") {
    writeClippedToStdout(buildAgenticDetailsView(limited, styles));
  } else {
    writeClippedToStdout(buildDetailsView(limited, styles));
  }
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
      // Prefer the provider's actual billed cost (OpenRouter reports it in
      // usage.cost) — exact and self-reconciling; fall back to the registry
      // estimate for providers that don't report it.
      const reportedCost = Number(usage?.cost || 0);
      const cost = reportedCost > 0 ? Number(reportedCost.toFixed(6)) : computeCost(candidate.pricing || selection.pricing, usage);
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
        // Provider-side id for ledger reconciliation (OpenRouter gen-…, etc.).
        providerRequestId: response.id || null,
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
      // If the provider returned a request id before failing, keep it — the call
      // may have billed, and the id makes the failed row reconcilable.
      if (error.providerRequestId) {
        attempt.providerRequestId = error.providerRequestId;
        await tools.setJob({ providerRequestId: error.providerRequestId });
      }
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

// ponytail: opencode's GET /session/:id/diff returned [] for bash-created
// files in the v1.18.4 spike — git status --porcelain is the source of truth
// for what a build-mode run actually touched.
async function listTouchedFiles(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    // ponytail: not a git repo (or git missing) — report no touched files
    return [];
  }
}

// Agentic execution via the OpenCode HTTP server. ponytail: no provider
// fallback chain in v1 — the FIRST provider of the model's chain is used
// (today always openrouter); a failure is a failure, no silent reroute.
async function executeAgenticTaskRequest(job, models, request, tools) {
  const selection = resolveModelSelection(models, request.model, request.provider);
  let candidate = selection.providers[0];
  const agent = request.write ? "cc-build" : "cc-plan";
  // Snapshot the dirty tree BEFORE the run so salvage reports only what THIS run changed.
  const baselineDirty = new Set(await listTouchedFiles(job.cwd).catch(() => []));

  if (request.opencodeSessionId) {
    await tools.log(
      `resuming opencode session ${request.opencodeSessionId} from job ${job.resumedFrom} (native continuity, no conversation replay)`,
    );
  }

  // Context guard on the packed prompt text (files/diff already inlined by
  // createTaskJob). ponytail: the ~14k-token agentic harness overhead per
  // message is NOT counted here — the guard measures only the payload.
  const contextGuard = evaluateContextWindow(models, selection.alias, [
    { role: "user", content: request.prompt },
  ]);
  await tools.setJob({ ctxPct: contextGuard.ctxPct });
  if (contextGuard.exceeded) {
    await tools.setJob({ contextExceeded: true });
    throw new Error(contextGuard.failMessage);
  }

  // Providers with a key (a forced --provider already narrowed this to one).
  // We fail over between them ONLY on pre-run REJECTIONS (credits/quota/limit —
  // no spend). A timeout or ambiguous error stops immediately: the call may have
  // run and billed, and blindly retrying elsewhere would double-spend.
  const usable = selection.providers.filter((p) => {
    const cfg = PROVIDERS[p.name];
    return !cfg?.envKey || process.env[cfg.envKey];
  });
  if (!usable.length) {
    const setupScript = path.join(path.dirname(ENTRYPOINT), "setup-keys.mjs");
    throw new Error(
      `no API key configured for any provider of model ${selection.alias}. ` +
        `Configure keys in a separate terminal: node "${setupScript}"`,
    );
  }

  const timeoutMs = request.callTimeoutMs || selection.timeoutMs || 900000;

  // Best-effort: skip providers already known to be out of balance (saves a
  // doomed call). Unknown balance -> attempt anyway.
  const keyValues = (await loadKeys()).values;
  const balances = {};
  for (const p of usable) {
    balances[p.name] = await fetchProviderBalance(p.name, keyValues).catch(() => null);
  }

  const REJECTION = /requires more credits|insufficient|balance|quota|max_tokens|rate.?limit|\b40[23]\b|\b429\b/i;
  const CONNECTION_RETRY = ["fetch failed", "econnreset", "socket hang up"];
  function isConnErr(err) {
    const m = String(err?.message || "").toLowerCase();
    if (m.includes("exceeded") || m.includes("__cc_timeout__")) return false;
    return CONNECTION_RETRY.some((h) => m.includes(h));
  }

  const releaseSlot = await acquireAgenticSlot(CC_DELEGATE_HOME, {
    jobId: job.id,
    onWait: (holder) =>
      tools.log(
        holder && Number.isInteger(holder.pid)
          ? `waiting for the agentic slot — held by pid ${holder.pid}${holder.jobId ? ` (job ${holder.jobId})` : ""}${holder.alive ? "" : " [holder dead — reclaiming]"}…`
          : "waiting for the agentic slot (another agentic job is running)…",
      ),
  });

  let latencyMs;
  let response;
  let server;
  let sessionId = request.opencodeSessionId || null;
  const rejections = [];

  try {
    try {
      const wroteLeanAgents = await ensureLeanAgents();
      if (wroteLeanAgents) {
        try { await stopServer(CC_DELEGATE_HOME); } catch {}
      }
      server = await ensureServer(CC_DELEGATE_HOME);
      if (!sessionId) {
        const session = await createSession(server);
        sessionId = session.id;
        await tools.log(`created opencode session ${sessionId}`);
      }
      await tools.setJob({ opencodeSessionId: sessionId, mode: "agentic", agent });

      for (let i = 0; i < usable.length; i += 1) {
        const cand = usable[i];
        const bal = balances[cand.name];
        if (bal && bal.remaining !== undefined && bal.remaining !== null && bal.remaining <= 0) {
          await tools.log(`skipping ${cand.name}: account balance exhausted ($${bal.remaining})`);
          rejections.push(`${cand.name}: balance $${bal.remaining}`);
          continue;
        }
        await tools.log(`attempting ${selection.alias} via ${cand.name}/${cand.id} (agent=${agent})`);
        const send = () =>
          sendMessage(server, sessionId, {
            text: request.prompt,
            agent,
            model: { providerID: cand.name, modelID: cand.id },
            timeoutMs,
          });
        const callStartedAt = Date.now();
        let resp;
        try {
          resp = await send();
        } catch (err) {
          if (isConnErr(err)) {
            await tools.log(`connection error on ${cand.name} (${err.message}); retrying once on a fresh session`);
            const s = await createSession(server);
            sessionId = s.id;
            await tools.setJob({ opencodeSessionId: sessionId });
            try {
              resp = await send();
            } catch (e2) {
              throw new Error(
                `agentic call failed for ${selection.alias} via ${cand.name} (session ${sessionId} on ${server.base}): ${e2.message}. ` +
                  `Not failing over — the call may have run and billed.`,
              );
            }
          } else {
            throw err;
          }
        }
        const ocError = resp?.info?.error;
        if (ocError) {
          const detail = ocError?.data?.message || ocError?.message || JSON.stringify(ocError);
          if (REJECTION.test(detail) && i < usable.length - 1) {
            await tools.log(`${cand.name} rejected: ${detail.slice(0, 90)} — failing over to next provider`);
            rejections.push(`${cand.name}: ${detail.slice(0, 120)}`);
            continue;
          }
          throw new Error(
            `agentic call rejected for ${selection.alias} via ${cand.name}: ${ocError.name || "error"} — ${detail}` +
              (rejections.length ? ` (earlier: ${rejections.join("; ")})` : ""),
          );
        }
        latencyMs = Date.now() - callStartedAt;
        candidate = cand;
        response = resp;
        break;
      }
      if (!response) {
        throw new Error(
          `agentic call failed for ${selection.alias}: no provider could serve it — ${rejections.join(" | ")}`,
        );
      }
    } catch (error) {
      // Salvage: a run can bill tokens (each tool turn) before failing. Capture
      // the real session cost so the failed ledger row reflects actual spend,
      // and any files touched before the failure.
      try {
        if (server && sessionId) {
          const msgs = await listMessages(server, sessionId);
          const su = sumSessionUsage(msgs);
          if (su.turns > 0) {
            await tools.setJob({
              cost: su.cost,
              usage: {
                prompt_tokens: su.input,
                completion_tokens: su.output + su.reasoning,
                total_tokens: su.input + su.output + su.reasoning,
              },
              provider: candidate.name,
              model: selection.alias,
            });
            await tools.log(`billed before failure: $${su.cost.toFixed(6)} across ${su.turns} model turns (recorded to the ledger)`);
          }
        }
      } catch {
        // best-effort — cost salvage never blocks the failure path
      }
      let touched = [];
      try {
        touched = (await listTouchedFiles(job.cwd)).filter((f) => !baselineDirty.has(f));
      } catch {
        // best-effort — never fail the salvage step
      }

      if (touched.length > 0) {
        await tools.setJob({ touchedFiles: touched, incomplete: true });
        throw new Error(
          `INCOMPLETE: ${touched.length} file(s) modified before the run failed: ${touched.join(", ")}. ` +
            `Review before retrying (a plain retry may double-edit a dirty tree). ` +
            `Underlying error: ${error.message}`,
        );
      }

      throw error; // true failure — nothing applied
    }
  } finally {
    await releaseSlot();
  }

  const { text, tokens, cost, modelID, providerID, reasoningTokens, cacheRead, cacheWrite, toolCalls } =
    extractText(response);
  // A genuine agentic run yields text and/or tool calls. An empty response with
  // no tools means the runtime/model produced nothing — never report that as a
  // success (it silently corrupts the caller's model of what shipped).
  if (!String(text || "").trim() && !(toolCalls > 0)) {
    throw new Error(
      `agentic run for ${selection.alias} via ${candidate.name} produced an empty response ` +
        `(no text, no tool calls) — treated as failed. Check provider health or retry with --provider/--model.`,
    );
  }
  // Cost/usage = SUM over every assistant turn in the session (the tool loop
  // bills each turn), not just the final message. Fetch once and reuse for the
  // activity log. Falls back to the final message's numbers if the fetch fails.
  let sessionMessages = [];
  try {
    sessionMessages = await listMessages(server, sessionId);
  } catch {
    // best-effort
  }
  const sessionUsage = sumSessionUsage(sessionMessages);
  const billedInput = sessionUsage.turns ? sessionUsage.input : tokens.input;
  const billedOutput = sessionUsage.turns ? sessionUsage.output : tokens.output;
  const billedReasoning = sessionUsage.turns ? sessionUsage.reasoning : tokens.reasoning;
  const billedCacheRead = sessionUsage.turns ? sessionUsage.cacheRead : cacheRead;
  const billedCacheWrite = sessionUsage.turns ? sessionUsage.cacheWrite : cacheWrite;
  const billedCost = sessionUsage.turns && sessionUsage.cost > 0 ? sessionUsage.cost : cost;
  if (sessionUsage.turns > 1) {
    await tools.log(`agentic cost: $${billedCost.toFixed(6)} across ${sessionUsage.turns} model turns (final message alone was $${Number(cost).toFixed(6)})`);
  }
  const usage = {
    prompt_tokens: billedInput,
    completion_tokens: billedOutput + billedReasoning,
    total_tokens: billedInput + billedOutput + billedReasoning,
  };

  let touchedFiles = [];
  let content = text;
  let appliedPatch = null;
  if (agent === "cc-build") {
    touchedFiles = (await listTouchedFiles(job.cwd)).filter((f) => !baselineDirty.has(f));

    // TRUST GATE 1 — no-op write. --write was requested but nothing changed on
    // disk. This is the "model returned replacement code in its message instead
    // of applying it" failure mode; reporting it as success is the most
    // dangerous outcome (an orchestrator would merge code that doesn't exist).
    if (touchedFiles.length === 0) {
      throw new Error(
        `NO-OP WRITE: --write was requested but no file changed on disk (${toolCalls} tool call(s) in the run). ` +
          `The model most likely returned replacement code in its message instead of applying it. ` +
          `Treated as failed — do NOT trust the report. Retry (consider --isolate, or a different model).`,
      );
    }

    // TRUST GATE 2 — ground the report in the REAL diff, and flag any file the
    // prose claims to have edited that has no corresponding change on disk.
    appliedPatch = await diffOfFiles(job.cwd, touchedFiles);
    const { notApplied } = reconcileClaims(text, touchedFiles);
    const warnLine = notApplied.length
      ? `\n\n⚠ CLAIMED-BUT-NOT-APPLIED: the report mentions ${notApplied.join(", ")} but no change to ${notApplied.length > 1 ? "those files" : "that file"} is present in the diff — VERIFY before trusting this result.`
      : "";
    content = `${text}\n\napplied (real diff) — files changed: ${touchedFiles.join(", ")}${warnLine}`;
    await tools.log(
      `applied files: ${touchedFiles.join(", ")}` +
        (notApplied.length ? ` | ⚠ claimed-but-not-applied: ${notApplied.join(", ")}` : ""),
    );
  }

  try {
    const activity = summarizeActivity(sessionMessages);
    if (activity.length > 0) {
      await tools.log(`agentic activity:\n${activity.map((l) => `  ${l}`).join("\n")}`);
    }
  } catch {
    // best-effort
  }

  return {
    provider: providerID || candidate.name,
    attempts: [],
    usage,
    cost: billedCost,
    latencyMs,
    ctxPct: contextGuard.ctxPct,
    contextAdvisory: contextGuard.advisoryLine,
    mode: "agentic",
    agent,
    opencodeSessionId: sessionId,
    reasoningTokens: billedReasoning,
    cacheRead: billedCacheRead,
    cacheWrite: billedCacheWrite,
    toolCalls,
    touchedCount: touchedFiles.length,
    result: {
      content,
      raw: response,
      modelId: modelID || candidate.id,
      alias: selection.alias,
      provider: providerID || candidate.name,
      touchedFiles,
      // The REAL diff of what this run wrote — the report is grounded in this,
      // not in the model's prose.
      appliedPatch,
    },
  };
}



// --isolate wrapper: run an agentic --write job inside a throwaway git worktree
// branched from repoDir's HEAD (carrying tracked working changes), so the job's
// edits can't corrupt the shared tree. Afterward we capture ONLY this job's own
// patch and merge it back, reporting a merge conflict loudly instead of clobbering.
// Touches executeAgenticTaskRequest ZERO — it just runs with job.cwd = the worktree.
async function runIsolatedAgentic(repoDir, job, models, request, tools) {
  let wt;
  try {
    wt = await createIsolatedWorktree(repoDir);
  } catch (err) {
    throw new Error(`--isolate requires a git repository at ${repoDir}: ${err.message}`);
  }
  const originalCwd = process.cwd();
  const jobInWt = { ...job, cwd: wt.dir };
  try {
    // chdir + first log inside the try so an early throw still hits the finally
    // (restore cwd + tear down the worktree) instead of stranding process.cwd().
    process.chdir(wt.dir);
    await tools.log(`isolated worktree ${wt.dir} (base ${wt.base.slice(0, 8)})`);
    const result = await executeAgenticTaskRequest(jobInWt, models, request, tools);
    const patch = await captureJobPatch(wt);
    if (!patch.trim()) {
      await tools.log("isolated run produced no file changes — nothing to merge");
      return result;
    }
    // deferMerge: the orchestrator merges after review — the worker only captures.
    if (request.deferMerge) {
      await tools.setJob({ jobPatch: patch });
      if (result.result) result.result.jobPatch = patch;
      await tools.log(`isolated patch captured (${(result.result?.touchedFiles || []).length} file(s)); merge deferred to orchestrator`);
      return result;
    }
    const merge = await mergePatchBack(repoDir, patch);
    const files = result.result?.touchedFiles || [];
    await tools.setJob({ jobPatch: patch, merged: merge.applied });
    let note;
    if (merge.applied) {
      note = `merged ${files.length} file(s) back to the working tree: ${files.join(", ") || "(see patch)"}`;
      await tools.log(note);
    } else {
      await tools.setJob({ mergeConflicts: merge.conflicts || [] });
      note = `⚠ merge conflict — patch NOT applied to the working tree. Conflicting: ${(merge.conflicts || []).join(", ")}. The job's own patch is saved on the job (jobPatch) for manual apply.`;
      await tools.log(note);
    }
    if (result.result) {
      result.result.content = `${result.result.content || ""}\n\n[isolate] ${note}`;
      result.result.merged = merge.applied;
      result.result.jobPatch = patch;
    }
    return result;
  } catch (err) {
    // Salvage the job's own patch for inspection before the worktree is torn down.
    try {
      const patch = await captureJobPatch(wt);
      if (patch.trim()) {
        await tools.setJob({ jobPatch: patch });
        await tools.log(`isolated run failed; its patch was saved on the job (jobPatch) before teardown`);
      }
    } catch {
      // best-effort
    }
    throw err;
  } finally {
    if (process.cwd() !== originalCwd) {
      try { process.chdir(originalCwd); } catch {}
    }
    await wt.cleanup();
  }
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
    mode: job.mode || "text",
    agent: job.agent || null,
    tokens: job.usage,
    cost: job.cost,
    error: job.error,
    resumedFrom: job.resumedFrom ?? null,
    elapsedMs,
    progressPreview,
    touchedFiles: job.result?.touchedFiles || null,
    incomplete: job.incomplete || false,
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
  // Real OpenRouter account balance (the true gate for paid calls).
  let openrouterCredits = null;
  if (payload.providers.openrouter?.keyPresent) {
    openrouterCredits = await fetchOpenRouterCredits(keys.values.OPENROUTER_API_KEY);
  }
  let siliconflowBalance = null;
  if (payload.providers.siliconflow?.keyPresent) {
    siliconflowBalance = await fetchSiliconFlowBalance(keys.values.SILICONFLOW_API_KEY);
  }
  const activeProviders = new Set(getActiveProviders(models));
  for (const [provider, data] of Object.entries(payload.providers)) {
    data.active = activeProviders.has(provider);
    const monthlyUsd = config.quotas[provider];
    if (monthlyUsd === undefined) {
      continue;
    }
    data.quota = computeQuotaStatus(provider, monthlyUsd, entries);
  }


  // --- Agentic (OpenCode) detection ---
  let agenticInstalled = false;
  let agenticVersion = null;
  let agenticServerRunning = false;
  try {
    agenticInstalled = await isOpencodeInstalled();
    if (agenticInstalled) {
      agenticVersion = await getOpencodeVersion();
      try {
        const ocState = await readServerState(CC_DELEGATE_HOME);
        if (ocState) {
          agenticServerRunning = await checkServerHealth({ base: ocState.base, auth: makeBasicAuth(ocState.password) });
        }
      } catch {
        // probe failed - server not running
      }
    }
  } catch {
    // detection failed - treat as not installed
  }

  if (flags.json) {
    payload.agentic = { installed: agenticInstalled, version: agenticVersion, serverRunning: agenticServerRunning };
    if (openrouterCredits) payload.openrouterCredits = openrouterCredits;
    if (siliconflowBalance) payload.siliconflowBalance = siliconflowBalance;
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
  if (openrouterCredits) {
    const r = openrouterCredits.remaining;
    const flag = r <= 0 ? " 🔴 OUT — top up to run paid models" : r < 1 ? " ⚠ low" : "";
    lines.push(`openrouter account credits: $${r.toFixed(2)} remaining ($${openrouterCredits.usage.toFixed(2)} of $${openrouterCredits.credits.toFixed(2)} used)${flag}`);
  }
  if (siliconflowBalance) {
    const b = siliconflowBalance.remaining;
    const flag = b <= 0 ? " 🔴 OUT" : b < 1 ? " ⚠ low" : "";
    lines.push(`siliconflow account balance: $${b.toFixed(2)}${flag}`);
  }
  lines.push(
    agenticServerRunning
      ? `agentic: opencode ${agenticVersion} — running (server up)`
      : agenticInstalled
        ? `agentic: opencode ${agenticVersion} — ready`
        : "agentic: not installed — npm i -g opencode-ai to enable",
  );
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
  // Fail fast before any prompt/provider/key work: agentic mode is useless
  // without the OpenCode CLI, and the install hint is actionable immediately.
  if (flags.agentic && !(await isOpencodeInstalled())) {
    throw new Error(
      "agentic mode requires the OpenCode CLI. Install: npm i -g opencode-ai (or brew install opencode), then re-run.",
    );
  }

  const prompt = await readPrompt(flags, positionals);
  const fileBlocks = await readFileAttachments(cwd, asArray(flags.file));
  const diffBlock = flags.diff ? await readGitDiff(cwd) : null;
  const userPrompt = buildUserMessage(prompt, fileBlocks, diffBlock);

  let model = String(flags.model || "qwen");
  let resumedFrom = null;
  let conversationSeed = null;
  let opencodeSessionId = null;
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
      if (flags.agentic) {
        // Native session continuity: the opencode server already holds the
        // thread — no conversation replay in agentic mode.
        opencodeSessionId = baseJob.opencodeSessionId || null;
      } else {
        conversationSeed = getBaseConversation(baseJob);
      }
    }
  }

  const request = {
    model,
    provider: typeof flags.provider === "string" ? flags.provider : null,
    system: typeof flags.system === "string" ? flags.system : DEFAULT_SYSTEM,
    maxTokens: flags["max-tokens"] !== undefined ? Number(flags["max-tokens"]) : undefined,
    prompt: userPrompt,
    conversationSeed,
    agentic: Boolean(flags.agentic),
    write: Boolean(flags.write),
    isolate: Boolean(flags.isolate),
    opencodeSessionId,
    callTimeoutMs: flags["call-timeout"] !== undefined
      ? Number(flags["call-timeout"]) * 1000
      : undefined,
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
    if (job.request?.agentic) {
      if (job.request.isolate && job.request.write) {
        return runIsolatedAgentic(cwd, job, models, job.request, tools);
      }
      return executeAgenticTaskRequest(job, models, job.request, tools);
    }
    return executeTaskRequest(job, models, job.request, tools);
  });
  const withQuota = await attachQuotaAlert(cwd, completed);
  return attachHealthAdvisory(cwd, withQuota);
}

const TASK_HELP = `cc-delegate task — delegate a bounded coding sub-task to a cheap model

Usage: cc-delegate task [flags] "<brief>"   (brief also via --prompt-file or stdin)

Flags:
  --model <alias>       qwen|deepseek|deepseek-pro|glm|kimi|kimi-fast|grok (default qwen)
  --provider <name>     force a provider: openrouter|siliconflow (else the model's chain)
  --agentic             run on a local OpenCode server with real tools (read/run/edit)
  --write               (agentic) allow file edits; default is read-only
  --isolate             (agentic --write) run in a throwaway git worktree, then
                        merge only this job's own patch back (conflict = not applied)
  --file <path>         attach a file as context (repeatable)
  --diff                attach \`git diff HEAD\` as context
  --resume <jobId|last> continue a previous job's thread
  --background          run detached; prints {jobId}; collect with status/result/watch
  --system <text>       override the system prompt
  --max-tokens <n>      cap output tokens
  --call-timeout <sec>  max seconds for one model call (default 900; agentic)
  --json                machine-readable output

Examples:
  cc-delegate task --model deepseek --file src/x.ts "write unit tests; return the full file"
  cc-delegate task --agentic --write --model glm "fix the failing test in api/"
  cc-delegate task --model glm --provider siliconflow "..."   # act on a breaker advisory`;

async function taskCommand(cwd, flags, positionals) {
  if (flags.help) {
    process.stdout.write(`${TASK_HELP}\n`);
    return 0;
  }
  const job = await createTaskJob(cwd, flags, positionals);

  if (flags.background) {
    const workerLog = await jobLogFilePath(cwd, job.id);
    const workerPid = spawnBackgroundWorker(ENTRYPOINT, cwd, job.id, workerLog);
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
    let statusLabel = payload.status;
    if (payload.incomplete) {
      statusLabel = "incomplete";
    }
    lines.push(`${payload.id} ${statusLabel} elapsed=${payload.elapsedMs}ms`);
    if (payload.mode === "agentic") {
      lines.push(`mode: agentic agent=${payload.agent || "plan"}`);
    }
    if (payload.resumedFrom) {
      lines.push(`resumed from ${payload.resumedFrom}`);
    }
    for (const line of payload.progressPreview) {
      lines.push(`  ${line}`);
    }

    // Show touched files when a run failed/incomplete and files were modified
    if (
      (payload.status === "failed" || payload.incomplete) &&
      Array.isArray(payload.touchedFiles) &&
      payload.touchedFiles.length > 0
    ) {
      lines.push(
        `modified before failure: ${payload.touchedFiles.join(", ")} (review before retrying)`,
      );
    }

    // Live activity summary for agentic jobs (best-effort, never throws)
    if (payload.mode === "agentic") {
      const job = await loadJob(cwd, jobId);
      if (job && job.opencodeSessionId) {
        try {
          const serverState = await readServerState(CC_DELEGATE_HOME);
          if (serverState) {
            const server = {
              base: serverState.base,
              auth: makeBasicAuth(serverState.password),
            };
            const messages = await listMessages(server, job.opencodeSessionId);
            const activity = summarizeActivity(messages);
            if (activity.length > 0) {
              lines.push("agentic activity:");
              for (const line of activity) {
                lines.push(`  ${line}`);
              }
            }
          }
        } catch {
          // silent fallback — log tail already shown above
        }
      }
    }

    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  lines.push(`running: ${payload.runningJobs.length}`);
  // Surface the agentic slot holder — a wedged slot used to be invisible.
  const slot = await readAgenticSlotHolder(CC_DELEGATE_HOME);
  if (slot && Number.isInteger(slot.pid)) {
    lines.push(
      slot.alive
        ? `agentic slot: held by pid ${slot.pid}${slot.jobId ? ` (job ${slot.jobId})` : ""}`
        : `agentic slot: STALE — held by dead pid ${slot.pid} (reclaimed on next agentic run; clear now: cc-delegate slot --release)`,
    );
  }
  if (payload.latestFinished) {
    lines.push(
      `latest finished: ${payload.latestFinished.id} ${payload.latestFinished.status}`,
    );
  }
  for (const job of payload.recent) {
    let displayStatus = job.status;
    if (job.incomplete) {
      displayStatus = "incomplete";
    }
    const resumedSuffix = job.resumedFrom ? ` (resumed from ${job.resumedFrom})` : "";
    lines.push(
      `${job.id} ${displayStatus} elapsed=${job.elapsedMs}ms${resumedSuffix}`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}



async function resultCommand(cwd, flags, positionals) {
  const jobId = positionals[0];
  const job = jobId
    ? await findJob(cwd, jobId)
    : await findLatestFinishedJob(cwd);
  if (!job) {
    throw new Error(
      jobId ? `job ${jobId} not found` : "no finished jobs found",
    );
  }

  const isIncomplete = job.incomplete === true;
  const payload = {
    id: job.id,
    status: isIncomplete ? "incomplete" : job.status,
    model: job.result?.alias || job.model,
    modelId: job.result?.modelId || null,
    provider: job.result?.provider || job.provider,
    mode: job.mode || null,
    agent: job.agent || null,
    usage: job.usage,
    cost: job.cost,
    error: job.error,
    output: job.result?.content || null,
    touchedFiles: job.result?.touchedFiles || null,
    quota: job.quota || null,
    advisory: job.advisory || null,
    contextAdvisory: job.contextAdvisory || null,
    resumedFrom: job.resumedFrom || null,
    incomplete: isIncomplete,
  };

  if (flags.json) {
    printJson(payload);
    return;
  }

  const alertPrefix = buildAlertPrefix(job);
  const resumedLine = payload.resumedFrom
    ? `resumed from ${payload.resumedFrom}\n`
    : "";

  if (payload.output) {
    process.stdout.write(`${resumedLine}${alertPrefix}${payload.output}\n`);
    if (
      (job.status === "failed" || isIncomplete) &&
      Array.isArray(payload.touchedFiles) &&
      payload.touchedFiles.length > 0
    ) {
      process.stdout.write(
        `modified before failure: ${payload.touchedFiles.join(", ")} (review before retrying)\n`,
      );
    }
    return;
  }

  process.stdout.write(
    `${resumedLine}${alertPrefix}${payload.error || "no output stored"}\n`,
  );
  if (
    (job.status === "failed" || isIncomplete) &&
    Array.isArray(payload.touchedFiles) &&
    payload.touchedFiles.length > 0
  ) {
    process.stdout.write(
      `modified before failure: ${payload.touchedFiles.join(", ")} (review before retrying)\n`,
    );
  }
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

async function opencodeCommand(flags, positionals) {
  const sub = positionals[0];

  if (sub === "status") {
    const installed = await isOpencodeInstalled();
    const version = installed ? await getOpencodeVersion() : null;
    const serverState = await readServerState(CC_DELEGATE_HOME);
    let healthy = false;
    if (serverState) {
      healthy = await checkServerHealth({
        base: serverState.base,
        auth: makeBasicAuth(serverState.password),
      });
    }

    const payload = {
      installed,
      version,
      server: serverState
        ? { pid: serverState.pid, port: serverState.port, healthy }
        : null,
    };
    if (flags.json) {
      printJson(payload);
      return;
    }

    const lines = [`installed: ${installed ? "yes" : "no"}`];
    if (version) {
      lines.push(`version: ${version}`);
    }
    if (serverState) {
      lines.push(`server: pid ${serverState.pid} port ${serverState.port} — ${healthy ? "healthy" : "not responding"}`);
    } else {
      lines.push("server: not running");
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  if (sub === "stop") {
    const stopped = await stopServer(CC_DELEGATE_HOME);
    process.stdout.write(stopped ? "stopped\n" : "no server running\n");
    return;
  }

  throw new Error("opencode requires a subcommand: status, stop");
}


async function uninstallCommand(flags) {
  const lines = [];
  try {
    await stopServer(CC_DELEGATE_HOME);
    lines.push("opencode server stopped (if it was running).");
  } catch {
    lines.push("opencode server: nothing to stop.");
  }
  const binDir = path.join(os.homedir(), ".local", "bin");
  for (const name of ["cc-delegate", "cc-delegate-keys"]) {
    try {
      await fs.unlink(path.join(binDir, name));
      lines.push(`removed ${path.join(binDir, name)}`);
    } catch {
      // not linked — fine
    }
  }
  if (flags.purge) {
    await fs.rm(CC_DELEGATE_HOME, { recursive: true, force: true });
    lines.push(`purged ${CC_DELEGATE_HOME} (keys, ledger, saved analyses).`);
    for (const agentName of ["cc-plan.md", "cc-build.md"]) {
      try { await fs.unlink(path.join(os.homedir(), ".config", "opencode", "agent", agentName)); } catch {}
    }
    lines.push("removed lean agent definitions from ~/.config/opencode/agent/.");
  } else {
    lines.push(`state kept at ${CC_DELEGATE_HOME} (use --purge to delete keys/ledger).`);
  }
  lines.push('Finish with: /plugin uninstall cc-delegate@claude-code-delegate');
  process.stdout.write(`${lines.join("\n")}\n`);
}


async function loadPromptTemplate(name) {
  const file = path.join(path.dirname(ENTRYPOINT), "..", "prompts", `${name}.md`);
  return fs.readFile(file, "utf8");
}

function parseReviewOutput(rawText) {
  let text = String(rawText || "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) {
    text = fence[1].trim();
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && (parsed.verdict === "pass" || parsed.verdict === "fail")) {
      return {
        verdict: parsed.verdict,
        summary: String(parsed.summary || ""),
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      };
    }
  } catch {
    // fall through
  }
  return { verdict: "fail", summary: "unparseable review output", findings: [], raw: rawText };
}

// Delegated code review of the working-tree diff. Reuses the text-mode task
// pipeline with --diff and a schema-constrained system prompt.
async function reviewCommand(cwd, flags, positionals) {
  const adversarial = Boolean(flags.adversarial);
  const model = flags.model || (adversarial ? "glm" : "deepseek");
  const focus = positionals.join(" ").trim() || "Review the working-tree diff for correctness.";
  const template = await loadPromptTemplate(adversarial ? "adversarial-review" : "review");
  const system = template.replace(/\{\{FOCUS\}\}/g, focus);

  const job = await createTaskJob(cwd, { model, diff: true, system }, [focus]);
  const completed = await runTask(cwd, job);
  if (completed.status !== "completed") {
    if (flags.json) {
      printJson({ verdict: "fail", summary: jobErrorMessage(completed), findings: [] });
    } else {
      process.stderr.write(`review failed: ${jobErrorMessage(completed)}\n`);
    }
    return 1;
  }

  const review = parseReviewOutput(completed.result?.content || "");
  if (flags.json) {
    printJson(review);
    return 0;
  }

  const styles = usageStyles();
  const banner =
    review.verdict === "pass"
      ? styles.green("PASS")
      : styles.red("FAIL");
  const lines = [`review (${model}${adversarial ? ", adversarial" : ""}): ${banner}`, review.summary];
  for (const f of review.findings) {
    const sev = f.severity || "P?";
    const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "";
    lines.push(`  ${styles.yellow(sev)} ${loc} — ${f.issue || ""}${f.fix ? `\n     fix: ${f.fix}` : ""}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return review.verdict === "pass" ? 0 : 1;
}

// Toggle the stop-review-gate: off (default) | warn | enforce | status.
async function gateCommand(positionals) {
  const arg = (positionals[0] || "status").toLowerCase();
  const config = await loadConfig();
  if (arg === "status") {
    process.stdout.write(`review gate: ${config.reviewGate || "off"}\n`);
    return 0;
  }
  if (!["off", "warn", "enforce"].includes(arg)) {
    process.stderr.write("usage: gate <off|warn|enforce|status>\n");
    return 1;
  }
  await saveConfig({ ...config, reviewGate: arg });
  process.stdout.write(`review gate set to: ${arg}\n`);
  return 0;
}

async function watchCommand(cwd, flags, positionals) {
  const jobId = positionals[0];
  if (!jobId) throw new Error("watch requires a job id");

  const job = await loadJob(cwd, jobId);
  if (!job) throw new Error(`job ${jobId} not found`);

  if (["completed", "failed", "cancelled"].includes(job.status)) {
    // Already finished — print final activity and exit
    await printFinalActivity(job);
    return 0;
  }

  let lastActivityLines = [];
  let lastLogSize = 0;

  const printLines = (lines) => {
    for (const line of lines) {
      process.stdout.write(`${line}\n`);
    }
  };

  const activityPoll = async () => {
    const current = await loadJob(cwd, jobId);
    if (!current || ["completed", "failed", "cancelled"].includes(current.status)) {
      process.exit(0);
    }
    if (current.opencodeSessionId) {
      try {
        const serverState = await readServerState(CC_DELEGATE_HOME);
        if (!serverState) throw new Error("no server");
        const server = { base: serverState.base, auth: makeBasicAuth(serverState.password) };
        const messages = await listMessages(server, current.opencodeSessionId);
        const activity = summarizeActivity(messages);
        const newLines = activity.slice(lastActivityLines.length);
        if (newLines.length > 0) {
          printLines(newLines);
          lastActivityLines = activity;
        }
      } catch {
        // fallback to log tail
        await tailLogPoll(current);
      }
    } else {
      await tailLogPoll(current);
    }
  };

  const tailLogPoll = async (current) => {
    try {
      const tailLines = await readJobLogTail(cwd, current.id, 100);
      if (tailLines.length > lastLogSize) {
        const newLines = tailLines.slice(lastLogSize);
        printLines(newLines);
        lastLogSize = tailLines.length;
      } else if (tailLines.length < lastLogSize) {
        lastLogSize = 0; // log rolled over, start fresh
      }
    } catch {
      // silent
    }
  };

  process.stdout.write(`watching ${jobId}...\n`);
  setInterval(activityPoll, 2000);
  // keep process alive indefinitely; exit triggered inside interval on terminal status
  return new Promise(() => {});
}

async function printFinalActivity(job) {
  try {
    if (job.opencodeSessionId) {
      const serverState = await readServerState(CC_DELEGATE_HOME);
      if (serverState) {
        const server = { base: serverState.base, auth: makeBasicAuth(serverState.password) };
        const messages = await listMessages(server, job.opencodeSessionId);
        const activity = summarizeActivity(messages);
        if (activity.length > 0) {
          process.stdout.write(`agentic activity:\n${activity.map(l => `  ${l}`).join("\n")}\n`);
        }
      }
    } else {
      const tail = await readJobLogTail(job.cwd, job.id, 20);
      for (const line of tail) process.stdout.write(`${line}\n`);
    }
  } catch {}
}

// Best-effort extract a JSON value from a model reply that may wrap it in prose
// or ```json fences. Returns the parsed value or null.
function parseJsonLoose(text) {
  if (!text) return null;
  let s = String(text).replace(/```(?:json)?/gi, "").trim();
  const firstArr = s.indexOf("[");
  const firstObj = s.indexOf("{");
  let start = -1;
  if (firstArr === -1) start = firstObj;
  else if (firstObj === -1) start = firstArr;
  else start = Math.min(firstArr, firstObj);
  if (start === -1) return null;
  const open = s[start];
  const close = open === "[" ? "]" : "}";
  const end = s.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

const ORCH_HELP = `cc-delegate orchestrate — a delegated model coordinates a fan-out of worker jobs

Usage:
  cc-delegate orchestrate [flags] "<one big brief to decompose>"
  cc-delegate orchestrate [flags] --tasks tasks.json

The orchestrator model plans/decomposes and reviews; each task runs on a worker
model in its OWN git worktree, IN PARALLEL (each an isolated OpenCode session on
the one shared server). Results are reviewed and only clean+passing patches are
merged back. Conflicts/failures/flags are returned for you to handle. It NEVER
self-approves — you are the final verifier.

Flags:
  --orchestrator-model <alias>  planner + reviewer (default kimi-fast)
  --worker-model <alias>        default executor per task (default deepseek-pro)
  --tasks <path>                JSON array [{title, brief, model?}]; else decompose the brief
  --max <n>                     cap number of tasks (default 8)
  --sequential                  run workers one-at-a-time instead of in parallel
  --json                        print the full report as JSON
  --prompt-file <path>          read the brief from a file

tasks.json shape: [{ "title": "...", "brief": "self-contained instructions", "model": "qwen" }]`;

async function orchestrateCommand(cwd, flags, positionals) {
  if (flags.help) {
    process.stdout.write(`${ORCH_HELP}\n`);
    return 0;
  }
  // orchestrate needs a git repo (workers isolate in worktrees, patches merge back)
  try {
    await execFileAsyncOrThrow(cwd);
  } catch (err) {
    throw new Error(`orchestrate requires a git repository at ${cwd}: ${err.message}`);
  }

  const orchestratorModel = String(flags["orchestrator-model"] || "kimi-fast");
  const workerModel = String(flags["worker-model"] || "deepseek-pro");
  const maxTasks = flags.max !== undefined ? Number(flags.max) : 8;

  // Read an explicit task list, or a brief to decompose.
  let tasks = null;
  let brief = null;
  if (typeof flags.tasks === "string") {
    const raw = await fs.readFile(path.resolve(flags.tasks), "utf8");
    const parsed = parseJsonLoose(raw);
    if (!Array.isArray(parsed) || !parsed.length) {
      throw new Error(`--tasks ${flags.tasks} must be a non-empty JSON array of {title, brief}`);
    }
    tasks = parsed.slice(0, maxTasks);
  } else {
    brief = await readPrompt(flags, positionals);
    if (!brief.trim()) {
      throw new Error("orchestrate needs a brief (positional/--prompt-file) or --tasks <file>");
    }
  }

  // A tracked text/agentic job run inline; returns the completed job.
  const inlineTask = async (jobCwd, request, preview) => {
    const job = await createJob(jobCwd, {
      cwd: jobCwd,
      command: "task",
      model: request.model,
      promptPreview: preview,
      request,
    });
    return runTask(jobCwd, job);
  };

  const deps = {
    log: (m) => process.stderr.write(`${m}\n`),
    planTasks: async (theBrief, model) => {
      const prompt =
        `Decompose the following software task into a list of BOUNDED, independent sub-tasks, each safe to hand to a fresh model with no memory. ` +
        `Return ONLY a JSON array; each element: {"title": short label, "brief": fully self-contained instructions incl. file paths and what "done" means, "model": optional alias}. ` +
        `Prefer few substantial tasks over many micro-tasks. Max ${maxTasks} tasks.\n\nTASK:\n${theBrief}`;
      const job = await inlineTask(cwd, { model, system: DEFAULT_SYSTEM, prompt, agentic: false }, "orchestrate:plan");
      const parsed = parseJsonLoose(job.result?.content);
      // Accept a bare array OR the common {"tasks": [...]} wrapper.
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.tasks) ? parsed.tasks : []);
      if (!arr.length) {
        throw new Error("orchestrator planner returned no usable tasks (model output was not a task array) — refine the brief or pass --tasks");
      }
      return { tasks: arr.slice(0, maxTasks), costUsd: job.cost || 0 };
    },
    runWorker: async (task, repoDir) => {
      const job = await inlineTask(
        repoDir,
        { model: task.model || workerModel, system: DEFAULT_SYSTEM, prompt: task.brief, agentic: true, write: true, isolate: true, deferMerge: true },
        task.title || "orchestrate:worker",
      );
      return {
        ok: job.status === "completed",
        patch: job.jobPatch || "",
        evidence: job.result?.content || job.error || "",
        costUsd: job.cost || 0,
      };
    },
    reviewResult: async ({ task, patch, evidence }, model) => {
      const prompt =
        `You are reviewing a delegated worker's patch for this task. Respond ONLY with JSON: {"verdict": "pass"|"fail"|"unsure", "findings": [short strings]}. ` +
        `"pass" only if the patch correctly and completely does the task with no obvious bug. Be strict; "unsure" if you can't tell.\n\n` +
        `TASK: ${task.title}\n${task.brief}\n\nWORKER NOTE:\n${(evidence || "").slice(0, 2000)}\n\nPATCH:\n${patch.slice(0, 12000)}`;
      const job = await inlineTask(cwd, { model, system: DEFAULT_SYSTEM, prompt, agentic: false }, "orchestrate:review");
      const parsed = parseJsonLoose(job.result?.content) || {};
      const verdict = ["pass", "fail", "unsure"].includes(parsed.verdict) ? parsed.verdict : "unsure";
      return { verdict, findings: Array.isArray(parsed.findings) ? parsed.findings : [], costUsd: job.cost || 0 };
    },
    mergePatchBack: (repoDir, patch) => mergePatchBack(repoDir, patch),
  };

  process.stderr.write(`orchestrating with ${orchestratorModel} (plan+review), workers default ${workerModel}…\n`);

  // Resolve the task list up front (decompose the brief if needed) so workers can
  // be pre-run in PARALLEL — each in its own OpenCode session pinned to its own
  // worktree, all on the one shared server. ponytail: --sequential falls back to
  // the one-at-a-time path (the pre-parallel behavior) if ever needed.
  let resolvedTasks = tasks;
  let planCostUsd = 0;
  if (!resolvedTasks) {
    const plan = await deps.planTasks(brief, orchestratorModel);
    resolvedTasks = plan.tasks;
    planCostUsd = plan.costUsd || 0;
  }
  const models = await readModelsRegistry();
  // Unique ids — the parallel results are keyed by id and looked up per task
  // during review/merge; a duplicate id would merge the wrong patch and drop work.
  const seenIds = new Set();
  resolvedTasks = resolvedTasks.slice(0, maxTasks).map((t, i) => {
    let id = t.id || `task-${i + 1}`;
    while (seenIds.has(id)) id = `${id}-${i + 1}`;
    seenIds.add(id);
    return {
      ...t,
      id,
      title: t.title || String(t.brief || "").slice(0, 60),
      model: t.model || workerModel,
    };
  });

  let runWorkerDep = deps.runWorker; // sequential default (used with --sequential)
  if (!flags.sequential) {
    // Map each task to a concrete provider/model and one shared parallel run.
    const workerTasks = resolvedTasks.map((t) => {
      const sel = resolveModelSelection(models, t.model, null);
      const usable = sel.providers.filter((p) => {
        const cfg = PROVIDERS[p.name];
        return !cfg?.envKey || process.env[cfg.envKey];
      });
      const p = usable[0] || sel.providers[0];
      if (!p) throw new Error(`orchestrate: no usable provider for model "${t.model}" (task ${t.id})`);
      return { id: t.id, title: t.title, brief: t.brief, model: { providerID: p.name, modelID: p.id }, timeoutMs: sel.timeoutMs || 900000 };
    });

    // Hold the agentic slot ONCE for the whole fan-out (so an external agentic
    // job doesn't fight the shared server); workers run concurrently within it.
    // ensureLeanAgents/stopServer live INSIDE the slot — stopping the server is
    // the most destructive op and must not run while another job holds the slot.
    const release = await acquireAgenticSlot(CC_DELEGATE_HOME, { jobId: "orchestrate" });
    let results;
    try {
      const wrote = await ensureLeanAgents();
      if (wrote) { try { await stopServer(CC_DELEGATE_HOME); } catch {} }
      process.stderr.write(`running ${workerTasks.length} workers in parallel (isolated OpenCode sessions)…\n`);
      results = await runAgenticWorkersParallel({
        tasks: workerTasks,
        repoDir: cwd,
        deps: {
          ensureServer,
          stateDir: CC_DELEGATE_HOME,
          createSession,
          sendMessage,
          extractText,
          listMessages,
          sumSessionUsage,
          createIsolatedWorktree,
          captureJobPatch,
          log: (m) => process.stderr.write(`${m}\n`),
        },
      });
    } finally {
      await release();
    }

    // Record each worker in the ledger (accurate cost) and build the lookup the
    // sequential review+merge loop consumes.
    const lookup = {};
    for (const r of results) {
      const wt = workerTasks.find((x) => x.id === r.id);
      const t = resolvedTasks.find((x) => x.id === r.id);
      await appendUsageLedger({
        id: r.id,
        status: r.ok ? "completed" : "failed",
        workspaceRoot: cwd,
        cwd,
        model: t.model,
        provider: wt.model.providerID,
        result: { alias: t.model, provider: wt.model.providerID, modelId: wt.model.modelID },
        cost: r.cost,
        usage: { prompt_tokens: r.usage.input, completion_tokens: r.usage.output + r.usage.reasoning },
        latencyMs: null,
        mode: "agentic",
        attempts: [{ provider: wt.model.providerID, outcome: r.ok ? "success" : "error" }],
      }).catch(() => {});
      lookup[r.id] = { ok: r.ok, patch: r.patch, evidence: r.evidence, costUsd: r.cost };
    }
    runWorkerDep = async (task) => lookup[task.id] || { ok: false, patch: "", evidence: "no parallel result", costUsd: 0 };
  }

  const report = await runOrchestration({
    tasks: resolvedTasks,
    repoDir: cwd,
    workerModel,
    orchestratorModel,
    deps: { ...deps, runWorker: runWorkerDep },
  });
  report.cost.orchestratorUsd = Number((report.cost.orchestratorUsd + planCostUsd).toFixed(6));
  report.cost.totalUsd = Number((report.cost.totalUsd + planCostUsd).toFixed(6));

  if (flags.json) {
    printJson(report);
    return report.requiresSeniorReview.length ? 1 : 0;
  }

  const L = [];
  L.push("");
  L.push(`orchestration complete — ${report.tasks.length} task(s)`);
  for (const t of report.tasks) {
    L.push(`  [${t.status}] ${t.id} — ${t.title}${t.review ? ` (review: ${t.review.verdict})` : ""}`);
  }
  L.push("");
  L.push(`merged: ${report.merged.length}  ·  conflicts: ${report.conflicts.length}  ·  flagged: ${report.flagged.length}  ·  failed: ${report.failed.length}  ·  empty: ${report.empty.length}`);
  L.push(`cost — orchestrator $${report.cost.orchestratorUsd.toFixed(6)}  ·  workers $${report.cost.workersUsd.toFixed(6)}  ·  total $${report.cost.totalUsd.toFixed(6)}`);
  if (report.requiresSeniorReview.length) {
    L.push("");
    L.push("⚠ requires your review (NOT merged / not trusted):");
    for (const r of report.requiresSeniorReview) {
      L.push(`  - ${r.id} ${r.title}: ${r.reason}`);
    }
    L.push("");
    L.push("Inspect a task's own patch: cc-delegate result <jobId>  (jobPatch field). Merged tasks are already in your working tree — review the diff before committing.");
  }
  process.stdout.write(`${L.join("\n")}\n`);
  return report.requiresSeniorReview.length ? 1 : 0;
}

// Throws unless cwd is inside a git work tree.
async function execFileAsyncOrThrow(cwd) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (stdout.trim() !== "true") throw new Error("not a git work tree");
}

const RECONCILE_HELP = `cc-delegate reconcile — cross-check our ledger against OpenRouter's own spend

Usage:
  cc-delegate reconcile [--set-baseline] [--json]

OpenRouter's /credits reports cumulative account usage; we diff spend-since-baseline
against our ledger so orphaned spend (failed/aborted calls that billed but we didn't
record) surfaces as a positive delta. Also lists 'unconfirmed' rows — calls that
reached a provider and failed, which MAY have billed — with their request ids so you
can cross-check them in OpenRouter's Activity log.

Flags:
  --set-baseline   record the current OpenRouter usage + ledger total as the zero point
  --json           machine-readable output`;

// Reconcile our ledger against OpenRouter's own cumulative spend. The analytics
// per-window endpoint isn't available to inference keys (404), so we use
// /credits (cumulative usage) with a stored baseline to compute a since-baseline
// delta. ponytail: OpenRouter only; SiliconFlow exposes balance, not cumulative usage.
async function reconcileCommand(flags) {
  if (flags.help) {
    process.stdout.write(`${RECONCILE_HELP}\n`);
    return 0;
  }
  const entries = await readUsageLedger();
  const ledgerTotal = entries.reduce((s, e) => s + Number(e.cost || 0), 0);
  const unconfirmed = entries.filter((e) => e.unconfirmed);
  const keys = (await loadKeys()).values;
  const cred = await fetchOpenRouterCredits(keys.OPENROUTER_API_KEY).catch(() => null);
  const baselineFile = path.join(CC_DELEGATE_HOME, "reconcile-baseline.json");

  if (flags["set-baseline"]) {
    if (!cred) {
      process.stderr.write("cannot set baseline: OpenRouter credits unavailable (no key or API error).\n");
      return 1;
    }
    const baseline = { ts: new Date().toISOString(), orUsage: cred.usage, ledgerTotal };
    await fs.writeFile(baselineFile, JSON.stringify(baseline, null, 2), "utf8");
    process.stdout.write(`baseline set: OpenRouter usage $${cred.usage.toFixed(4)}, ledger $${ledgerTotal.toFixed(4)} @ ${baseline.ts}\n`);
    return 0;
  }

  let baseline = null;
  try { baseline = JSON.parse(await fs.readFile(baselineFile, "utf8")); } catch {}

  const report = {
    ledgerTotalUsd: Number(ledgerTotal.toFixed(6)),
    unconfirmedCount: unconfirmed.length,
    openrouter: cred ? { cumulativeUsageUsd: cred.usage, remainingUsd: cred.remaining } : null,
    baseline,
    sinceBaseline: null,
  };
  if (baseline && cred) {
    const orDelta = cred.usage - baseline.orUsage;
    const ledgerDelta = ledgerTotal - baseline.ledgerTotal;
    report.sinceBaseline = {
      openrouterDeltaUsd: Number(orDelta.toFixed(6)),
      ledgerDeltaUsd: Number(ledgerDelta.toFixed(6)),
      unreconciledUsd: Number((orDelta - ledgerDelta).toFixed(6)),
    };
  }

  if (flags.json) {
    printJson(report);
    return 0;
  }

  const L = [];
  L.push(`ledger recorded spend: $${ledgerTotal.toFixed(6)} over ${entries.length} rows`);
  if (cred) {
    L.push(`OpenRouter cumulative usage: $${cred.usage.toFixed(4)}  ·  remaining credit: $${cred.remaining.toFixed(4)}`);
  } else {
    L.push("OpenRouter usage: unavailable (no key or API error)");
  }
  if (report.sinceBaseline) {
    const s = report.sinceBaseline;
    L.push("");
    L.push(`since baseline (${baseline.ts}):`);
    L.push(`  OpenRouter +$${s.openrouterDeltaUsd.toFixed(6)}  ·  ledger +$${s.ledgerDeltaUsd.toFixed(6)}  ·  unreconciled +$${s.unreconciledUsd.toFixed(6)}`);
    if (s.unreconciledUsd > 0.0005) {
      L.push(`  ⚠ $${s.unreconciledUsd.toFixed(6)} of OpenRouter spend is not in our ledger — likely failed/aborted calls that billed. Check the unconfirmed rows below and OpenRouter Activity.`);
    }
  } else {
    L.push("");
    L.push("no baseline yet — run `cc-delegate reconcile --set-baseline` to start tracking the delta (a raw diff would include pre-ledger history and other apps on this key).");
  }
  if (unconfirmed.length) {
    L.push("");
    L.push(`unconfirmed rows (reached a provider, then failed — MAY have billed): ${unconfirmed.length}`);
    for (const e of unconfirmed.slice(-10)) {
      L.push(`  ${e.ts}  ${e.model || "-"} via ${e.provider || "-"}  id=${e.providerRequestId || "(none)"}`);
    }
    L.push("  → cross-check these ids/timestamps in OpenRouter's Activity log.");
  }
  process.stdout.write(`${L.join("\n")}\n`);
  return 0;
}

// Inspect or clear the agentic run slot. Agentic jobs serialize on a single
// lock; a crashed holder is now reclaimed by liveness automatically, but this
// gives an operator a way to see/force-clear a wedged slot.
async function slotCommand(flags) {
  const lockFile = path.join(CC_DELEGATE_HOME, "agentic-run.lock");
  const holder = await readAgenticSlotHolder(CC_DELEGATE_HOME);

  if (flags.release) {
    if (!holder) {
      process.stdout.write("agentic slot already free — nothing to release.\n");
      return 0;
    }
    if (holder.alive && !flags.force) {
      process.stderr.write(
        `refusing to release: the holder (pid ${holder.pid}${holder.jobId ? `, job ${holder.jobId}` : ""}) is still ALIVE. ` +
          `Cancel that job, or pass --force to release anyway.\n`,
      );
      return 1;
    }
    await fs.rm(lockFile, { force: true });
    process.stdout.write(`released the agentic slot (was held by pid ${holder.pid}${holder.alive ? " — forced" : " — holder was dead"}).\n`);
    return 0;
  }

  if (flags.json) {
    printJson({ held: Boolean(holder), holder });
    return 0;
  }
  if (!holder) {
    process.stdout.write("agentic slot: free\n");
    return 0;
  }
  process.stdout.write(
    `agentic slot: HELD by pid ${holder.pid}${holder.jobId ? ` (job ${holder.jobId})` : ""}` +
      `${holder.startedAt ? ` since ${holder.startedAt}` : ""} — holder ${holder.alive ? "alive" : "DEAD (will be reclaimed on next acquire)"}\n` +
      (holder.alive ? "" : "clear it now with: cc-delegate slot --release\n"),
  );
  return 0;
}

async function main() {
  const { command, cwd, flags, positionals } = parseArgs();

  if (!command) {
    throw new Error(
      "subcommand required: setup, models, task, orchestrate, task-worker, status, result, cancel, usage, analysis, review, adversarial-review, gate, opencode, slot, reconcile, watch, uninstall, link",
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
    case "orchestrate":
      return orchestrateCommand(cwd, flags, positionals);
    case "slot":
      return slotCommand(flags);
    case "reconcile":
      return reconcileCommand(flags);
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
    case "uninstall":
      await uninstallCommand(flags);
      return 0;
    case "opencode":
      await opencodeCommand(flags, positionals);
      return 0;
    case "review":
      return reviewCommand(cwd, flags, positionals);
    case "adversarial-review":
      return reviewCommand(cwd, { ...flags, adversarial: true }, positionals);
    case "gate":
      return gateCommand(positionals);
    case "watch":
      return watchCommand(cwd, flags, positionals);
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
