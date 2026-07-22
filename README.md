# claude-code-delegate

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

A [Claude Code](https://claude.com/claude-code) plugin marketplace. Its one plugin, `cc-delegate`, delegates bounded coding sub-tasks — boilerplate, tests, mechanical refactors, diff review, long-context analysis — from Claude Code to external frontier models (Qwen3-Coder-Next, Kimi K3, DeepSeek V4-Flash, GLM-5.2, Grok 4.5) over OpenAI-compatible APIs (OpenRouter, SiliconFlow, DeepInfra, Cerebras), so the expensive Claude context in your session is spent on planning and judgment rather than on generation. The architecture mirrors the `openai-codex` plugin: a companion runtime script, a thin forwarding subagent, and a set of slash commands.

## Why

Token economics. In a planner/executor split, the planner (Claude) reads the repo, makes decisions, and reviews results — that's where the expensive context belongs. The executor just turns a well-specified brief into code or a diff, and that job doesn't need a frontier-tier model to do it well. The models in the matrix below are 10-1000x cheaper per token than Claude and, for bounded generation tasks, close the gap. One real logged delegation — a code-writing request routed to the cheapest model in the fleet — cost **$0.000013**. Keeping the planner on Claude and pushing bulk generation onto cheaper external models cuts the cost of large or repetitive tasks without touching the quality of the parts that actually require judgment.

## Features

- **Model fleet with provider fallback chains** — six models, each mapped to one or more providers; a failing provider falls through to the next one that serves that model.
- **Background jobs** — detached processes with disk-persisted state, so `status`/`result`/`cancel` work from a later, unrelated Claude Code turn.
- **Usage ledger + interactive tabbed TUI** — `Overview` / `Details` / `Health` / `Quotas` / `Analyze` tabs; `←`/`→` or `1`-`5` to switch, `r` to reload, `q`/Esc/Ctrl-C to exit.
- **Per-request details & provider health** — success rate, p95 latency, fallback rate, and `⚠` WARNs per model and per provider.
- **Monthly spend quotas + non-blocking alerts** — per-provider USD quotas with `⚠`/`🔴` alerts; delegations are never blocked by quota.
- **Circuit-breaker advisories** — quality-aware suggestions to switch provider or model when a (model, provider) pair looks degraded.
- **Context-window guard** — fails fast before calling a provider if a prompt clearly won't fit, and prints a non-blocking advisory at ≥70% of the context window; a `CTX%` column tracks it per request.
- **AI analysis via `/cc-delegate:analyze`** — a subagent reads usage/details/health JSON and produces a cost/health readout, persisted to disk and shown in the TUI's Analyze tab.
- **Interactive hidden-input key setup** — `cc-delegate-keys` masks pasted keys as you type.
- **Global CLI via `cc-delegate link`** — installs `cc-delegate`/`cc-delegate-keys` wrappers onto your `PATH` so both work from any terminal.
- **Per-Claude-session usage attribution** — a `SessionStart` hook stamps each delegation with the Claude Code session that made it.

## Install

```
/plugin marketplace add NightZpy/claude-code-delegate
/plugin install cc-delegate@claude-code-delegate
```

Reload Claude Code, then optionally:

```
! cc-delegate link    # installs the cc-delegate / cc-delegate-keys wrappers onto your PATH
! cc-delegate-keys     # interactive key + quota setup
```

`cc-delegate-keys` walks you through the active provider keys, but you don't need all of them — a single OpenRouter key alone covers every model in the fleet.

## Model matrix

Data from research as of July 2026.

| Alias | Model (OpenRouter ID) | Role | Ctx | $/1M in/out | Quality | Rough equivalent | Notes |
|---|---|---|---|---|---|---|---|
| `qwen` | Qwen3-Coder-Next (`qwen/qwen3-coder-next`) | Bulk codegen, refactors, tests | 262K | $0.11 / $0.80 | 3 | ~Sonnet (low tier) / GPT-5.4 | Weak on terminal use (Terminal-Bench 36.2%) |
| `deepseek` | DeepSeek V4-Flash (`deepseek/deepseek-v4-flash`) | Fast debugging, diff review, boilerplate | 1M | $0.09 / $0.18 | 2 | ~Haiku 4.5 / GPT-5.4-mini | Cheapest of the fleet; SiliconFlow serves the same V4-Flash as a fallback |
| `deepseek-pro` | DeepSeek V4-Pro (`deepseek/deepseek-v4-pro`) | Flagship-grade codegen, demanding tasks | 1M | $0.435 / $0.87 | ~Sonnet 5 (claimed, unverified) | DeepSeek flagship (1.6T); claims SWE-bench 80.6% (vendor); cheaper than GLM via OpenRouter |
| `glm` | GLM-5.2 (`z-ai/glm-5.2`) | Multi-step agentic refactoring, tool-use | 1M | $0.79 / $2.48 | 4 | ~Sonnet 5 / GPT-5.5 | Strongest independently verified result of the lot: SWE-bench Pro 62.1%, #1 open-weight (Morph LLM); Artificial Analysis Index 51 |
| `grok` | Grok 4.5 (`x-ai/grok-4.5`) | Frontier generalist, second opinions | 500K | $2.00 / $6.00 | 4 | ~Opus 4.8 / GPT-5.5 | xAI's latest (Jul 2026); OpenRouter only in v1 |
| `kimi` | Kimi K3 (`moonshotai/kimi-k3`) | Long-context auditing, deep reasoning | 1M | $3.00 / $15.00 | 5 | ~Opus 4.8 / GPT-5.5 | Artificial Analysis Index 57 (#4 global); expensive, slow (34 tok/s), always-on thinking is billed, frequent 429s |

**Benchmark caveat:** most of the vendor-reported SWE-bench figures above 75% for these models are self-reported and not confirmed on neutral leaderboards. The only independently verified number here is GLM-5.2's SWE-bench Pro result (62.1%, morphllm-verified).

## Commands

### Slash commands

| Command | Description | Example |
|---|---|---|
| `/cc-delegate:task` | Delegate a task, picking model/provider explicitly | `/cc-delegate:task --model glm "refactor this module to use async/await"` |
| `/cc-delegate:qwen` | Delegate to Qwen3-Coder-Next | `/cc-delegate:qwen "write unit tests for src/parser.ts"` |
| `/cc-delegate:kimi` | Delegate to Kimi K3 | `/cc-delegate:kimi --file src/**/*.ts "audit this module for race conditions"` |
| `/cc-delegate:deepseek-pro` | Delegate to DeepSeek V4-Pro | `/cc-delegate:deepseek-pro "implement the parser module"` |
| `/cc-delegate:deepseek` | Delegate to DeepSeek V4-Flash | `/cc-delegate:deepseek --diff "review this diff for bugs"` |
| `/cc-delegate:glm` | Delegate to GLM-5.2 | `/cc-delegate:glm "migrate this file from class components to hooks"` |
| `/cc-delegate:grok` | Delegate to Grok 4.5 | `/cc-delegate:grok "second opinion on this design"` |
| `/cc-delegate:status` | Check a background job's status | `/cc-delegate:status <jobId>` |
| `/cc-delegate:result` | Fetch a finished background job's output | `/cc-delegate:result <jobId>` |
| `/cc-delegate:cancel` | Cancel a running background job | `/cc-delegate:cancel <jobId>` |
| `/cc-delegate:usage` | Show aggregated token and cost usage (`--details` for per-request rows, `--health` for reliability) | `/cc-delegate:usage --days 7 --model qwen --session current` |
| `/cc-delegate:analyze` | Feed usage/details/health JSON to a subagent for cost and health recommendations | `/cc-delegate:analyze --days 7` |
| `/cc-delegate:setup` | Check readiness (keys present, providers reachable) | `/cc-delegate:setup` |

### CLI (`companion.mjs`, or `cc-delegate` after `cc-delegate link`)

```
cc-delegate setup [--json]
cc-delegate models [--guide] [--json]
cc-delegate task [--background] [--model qwen|deepseek|deepseek-pro|glm|kimi|grok] [--provider openrouter|siliconflow]
               [--file <path>]... [--diff] [--system <txt>] [--max-tokens N] [--prompt-file <path>]
               [--resume <jobId|last>] [--json] "<prompt>"
cc-delegate status [job-id] [--all] [--json]
cc-delegate result [job-id] [--json]
cc-delegate cancel [job-id]
cc-delegate usage [--days N] [--model X] [--session <id|current>] [--json]
cc-delegate usage --details [--model X] [--provider Y] [--limit N] [--days N] [--session <id|current>] [--json]
cc-delegate usage --health [--days N] [--session <id|current>] [--json]
cc-delegate analysis show [--json]
cc-delegate link
```

`models --guide` prints the same provider price/verdict guide shown at the top of `cc-delegate-keys`. `analysis save` is written internally by `/cc-delegate:analyze`; `analysis show` reprints the last saved analysis standalone.

## Iterative direction (threads)

A completed task's full conversation (system + user + assistant, text only) is persisted on its job. `task --resume <jobId|last>` appends a new user turn to that history and re-sends the whole thread to the same model, instead of starting a fresh, context-free task each time:

```
cc-delegate task "add input validation to src/parser.ts"
cc-delegate task --resume last "now add unit tests for the invalid-input cases"
cc-delegate task --resume last "also handle empty-string input"
```

`--resume last` resumes the most recently completed job; a job id (or unambiguous prefix) resumes that job specifically. Only a `completed` job can be resumed — resuming a `failed` or `cancelled` job is a clear error. `status`/`result` show `resumedFrom` on a resumed job's output (`--json` too). An explicit `--model` that differs from the base job's model starts the new job without history (logged) rather than silently mixing conversations across models.

## Monitoring & cost control

Run `cc-delegate usage` with no flags in a terminal and it opens the interactive tabbed viewer (Overview / Details / Health / Quotas / Analyze) instead of printing static text. Any view flag (`--details`, `--health`, `--json`) or `--static` forces plain scriptable output — that's what `/cc-delegate:usage` always uses, since it runs over a pipe (never a TTY).

- **Ledger**: every provider response appends one JSONL record to `~/.claude/cc-delegate/usage.jsonl` — job id, model, provider, tokens, cost, latency, `ctxPct`, status.
- **Health**: `--health` aggregates success rate, average/p95 latency, fallback rate, and average cost per model and per provider, printing `⚠` when a model or provider looks unhealthy (success rate under 80% over 5+ requests, p95 latency over 60s, or fallback rate over 30%).
- **Quotas**: `cc-delegate-keys` prompts for an optional monthly USD quota per provider (config in `~/.claude/cc-delegate/config.json`); crossing 80% prints a `⚠` warning, 100%+ a `🔴` critical alert. Quotas are informational only — delegations are never blocked.
- **Circuit-breaker advisories**: after each task, the runtime checks the health of the (model, provider) pair that served it over its last 20 ledger entries; a degraded pair prepends a `⚡ circuit-breaker advisory` to the task output with ranked suggestions (same model via another provider first, then other models of equal-or-higher `quality`).
- **Context-window guard**: the runtime estimates the assembled prompt's token count against the chosen model's context size. A prompt that clearly won't fit fails fast, before any provider/key check, with suggestions for models with a large-enough window; crossing 70% prints a non-blocking `⚠ context` advisory instead.

**Note for orchestrators:** task outputs may carry circuit-breaker and context advisories — honor them on the next dispatch rather than retrying the same (model, provider) pair blind.

## Security

- Keys live only in `~/.claude/cc-delegate/.env`, written with `chmod 600`, and are never committed to any repo.
- `cc-delegate-keys` uses hidden input — pasted keys are masked as you type.
- Anywhere a key is displayed (setup output, TUI), it's shown as a masked hint (`first8…last4`), never in full.
- Nothing leaves your machine except the API calls to the provider(s) you configured — no telemetry, no third-party relay beyond the provider itself.

## How it works

All commands and the `cc-delegate:runner` agent forward to a single companion runtime, `plugins/cc-delegate/scripts/companion.mjs`. Background jobs run as a detached process with state persisted to disk under `~/.claude/cc-delegate/`, so `status`/`result`/`cancel` can be called from a later, unrelated Claude Code turn. `--file` and `--diff` read local content and fold it into the prompt sent to the external model — the model itself has no filesystem or tool access. Each model alias maps to one or more providers; if the pinned or default provider fails, the runtime retries against the next one that serves that model.

v1 is text-in/text-out: the external model has no tools and returns code or patches as text, which Claude then applies and verifies. There is no agentic loop in this version.

```
claude-code-delegate/
  .claude-plugin/
    marketplace.json
  plugins/
    cc-delegate/
      .claude-plugin/
        plugin.json
      agents/
        runner.md                   # thin forwarder subagent
      commands/
        task.md, qwen.md, kimi.md, deepseek.md, glm.md, grok.md
        status.md, result.md, cancel.md, usage.md, analyze.md, setup.md
      hooks/
        hooks.json                  # SessionStart hook to persist Claude session id
      config/
        models.json                 # model/provider/pricing registry
      scripts/
        companion.mjs                # runtime: setup, models, task, status, result, cancel, usage, analysis, link
        session-hook.mjs            # writes CC_DELEGATE_SESSION_ID into Claude env file
        setup-keys.mjs              # interactive key + quota setup
        lib/                        # shared helpers (provider guide, config, quota, styles, ansi)
      skills/
        runtime/
          SKILL.md                  # internal call contract for runner
```

## Using with plan-big-execute-small

The `plan-big-execute-small` skill already splits execution between Claude subagents and Codex. `cc-delegate` is a third, cheaper executor fleet for the same pattern: pure-generation steps that don't need tool access — bulk boilerplate, mechanical text refactors, test writing, diff review, very-long-context analysis — can go to a frontier model instead of a Claude or Codex subagent, with Claude (or a cheap subagent) still responsible for applying and verifying the output.

## Roadmap

- Agentic loop: give the external model bounded tool access instead of text-in/text-out.
- Streaming output for foreground tasks.
- Cache-aware costing: several providers already report `cachedInput` pricing in the model registry; the runtime doesn't yet use it to discount repeat-context requests.
- Dynamic, price-aware provider ordering instead of a fixed fallback chain.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
