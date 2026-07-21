import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/args.mjs";
import { ENV_FILE, USAGE_LEDGER_FILE, loadKeys } from "./lib/env.mjs";
import { runTrackedJob, spawnBackgroundWorker } from "./lib/jobs.mjs";
import { PROVIDERS, callProvider } from "./lib/providers.mjs";
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

function padCell(value, width, align = "left") {
  const text = String(value);
  return align === "right" ? text.padStart(width) : text.padEnd(width);
}

function formatUsd(value) {
  return Number(value || 0).toFixed(6);
}

function formatInteger(value) {
  return Math.round(Number(value || 0)).toLocaleString("en-US");
}

function formatSessionLabel(value) {
  if (value === null || value === undefined || value === "") {
    return "(no session)";
  }
  const text = String(value);
  return text.length > 8 ? `${text.slice(0, 8)}…` : text;
}

function printAlignedTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(
      header.label.length,
      ...rows.map((row) => String(row[index] ?? "").length),
    ),
  );
  const lines = [
    headers.map((header, index) => padCell(header.label, widths[index], header.align)).join("  "),
    headers.map((_, index) => "-".repeat(widths[index])).join("  "),
    ...rows.map((row) =>
      headers
        .map((header, index) => padCell(row[index] ?? "", widths[index], header.align))
        .join("  "),
    ),
  ];
  return lines.join("\n");
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

function aggregateUsage(entries) {
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

async function usageCommand(flags) {
  const entries = await readUsageLedger();
  const modelFilter = typeof flags.model === "string" ? flags.model : null;
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
        process.stdout.write("no current session id (FRONTIER_SESSION_ID not set)\n");
        return;
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

  const payload = {
    ...aggregateUsage(filtered),
    since: since ? since.toISOString() : null,
  };

  if (flags.json) {
    printJson(payload);
    return;
  }

  if (!filtered.length) {
    process.stdout.write("no usage recorded yet\n");
    return;
  }

  const summary = [
    "Summary",
    `jobs: ${formatInteger(payload.totals.jobs)}`,
    `prompt tokens: ${formatInteger(payload.totals.promptTokens)}`,
    `completion tokens: ${formatInteger(payload.totals.completionTokens)}`,
    `total cost USD: ${formatUsd(payload.totals.cost)}`,
  ];

  const modelRows = sortUsageBuckets(payload.byModel).map(([name, stats]) => [
    name,
    formatInteger(stats.jobs),
    formatInteger(stats.promptTokens),
    formatInteger(stats.completionTokens),
    formatUsd(stats.cost),
  ]);
  const providerRows = sortUsageBuckets(payload.byProvider).map(([name, stats]) => [
    name,
    formatInteger(stats.jobs),
    formatInteger(stats.promptTokens),
    formatInteger(stats.completionTokens),
    formatUsd(stats.cost),
  ]);
  const sessionRows = sortUsageBuckets(payload.bySession).map(([name, stats]) => [
    formatSessionLabel(name === "null" ? null : name),
    formatInteger(stats.jobs),
    formatInteger(stats.promptTokens),
    formatInteger(stats.completionTokens),
    formatUsd(stats.cost),
  ]);

  const sections = [
    summary.join("\n"),
    `By model\n${printAlignedTable(
      [
        { label: "MODEL", align: "left" },
        { label: "JOBS", align: "right" },
        { label: "PROMPT TOKENS", align: "right" },
        { label: "COMPLETION TOKENS", align: "right" },
        { label: "COST USD", align: "right" },
      ],
      modelRows,
    )}`,
    `By provider\n${printAlignedTable(
      [
        { label: "PROVIDER", align: "left" },
        { label: "JOBS", align: "right" },
        { label: "PROMPT TOKENS", align: "right" },
        { label: "COMPLETION TOKENS", align: "right" },
        { label: "COST USD", align: "right" },
      ],
      providerRows,
    )}`,
    `By session\n${printAlignedTable(
      [
        { label: "SESSION", align: "left" },
        { label: "JOBS", align: "right" },
        { label: "PROMPT TOKENS", align: "right" },
        { label: "COMPLETION TOKENS", align: "right" },
        { label: "COST USD", align: "right" },
      ],
      sessionRows,
    )}`,
  ];
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
      const response = await callProvider(candidate.name, candidate.id, messages, {
        maxTokens: request.maxTokens,
      });
      const usage = normalizeUsage(response.usage);
      const content =
        response.choices?.[0]?.message?.content ??
        response.choices?.[0]?.text ??
        "";
      const cost = computeCost(selection.pricing, usage);
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
        `Configure keys by running this in your terminal (or type it prefixed with "! " in Claude Code):\n` +
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
      openrouter: { keyPresent: Boolean(keys.values.OPENROUTER_API_KEY) },
      siliconflow: { keyPresent: Boolean(keys.values.SILICONFLOW_API_KEY) },
      deepinfra: { keyPresent: Boolean(keys.values.DEEPINFRA_API_KEY) },
      cerebras: { keyPresent: Boolean(keys.values.CEREBRAS_API_KEY) },
    },
  };

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
    lines.push(`${provider}: ${data.keyPresent ? "key present" : "missing"}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function modelsCommand(flags) {
  const models = await readModelsRegistry();
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

async function runTask(cwd, job) {
  await loadKeys();
  const models = await readModelsRegistry();
  return runTrackedJob(cwd, job.id, async (tools) => {
    const outcome = await executeTaskRequest(job, models, job.request, tools);
    return outcome;
  });
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
    process.stdout.write(`${completed.result?.content || ""}\n`);
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
  };

  if (flags.json) {
    printJson(payload);
    return;
  }

  if (payload.output) {
    process.stdout.write(`${payload.output}\n`);
    return;
  }

  process.stdout.write(`${payload.error || "no output stored"}\n`);
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

async function main() {
  const { command, cwd, flags, positionals } = parseArgs();

  if (!command) {
    throw new Error("subcommand required: setup, models, task, task-worker, status, result, cancel, usage");
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
