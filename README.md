# claude-code-delegate

Delegate bounded coding sub-tasks from Claude Code to cheap frontier models (Qwen3-Coder-Next, Kimi K3, DeepSeek V4-Flash, GLM-5.2, Grok 4.5, and more) over OpenAI-compatible APIs. Claude stays in the architect’s seat — planning, reading the repo, and reviewing results — while execution work is pushed to models that cost 10–1000× less per token.

## Why

Token economics. The expensive Claude context belongs on decisions, not on bulk generation. The models in the matrix below are 10–1000× cheaper and, for well-specified generation, close the quality gap. This plugin itself was largely built by delegating sub-tasks to cheap models for a total spend of about **$1.23**. A single code-writing delegation to the fleet’s cheapest model can cost as little as **$0.000013**.

Where the `openai-codex` plugin delegates to one model, cc-delegate operates a delegation *fleet* — cost accounting, health monitoring, spend quotas, circuit-breaker failover, a context-window guard, and an optional review gate. Everything an orchestrator needs to delegate fully and safely.

## Two modes at a glance

|                  | TEXT mode (default)                         | AGENTIC mode (`--agentic`)                         |
| ---------------- | ------------------------------------------- | -------------------------------------------------- |
| **How**          | Single text-completion API call             | Local OpenCode server; full tool loop              |
| **Tools**        | None (prompt in, text out)                  | Read files, run commands, apply edits (`--write`)  |
| **Cost**         | As low as ~$0.0001 per request              | ~100× TEXT overhead from harness tokens            |
| **Context**      | Whatever fits in the model’s ctx window     | Same, plus ~13–14k tokens of tooling overhead      |
| **Best for**     | Pure generation, diff review, boilerplate   | Steps that need the repo, commands, or file edits  |

**When to use:** Prefer TEXT for any task a self-contained brief can carry. Use AGENTIC only when the step genuinely needs to read, run, or edit within the working tree.

## Install

```
/plugin marketplace add NightZpy/claude-code-delegate
/plugin install cc-delegate@claude-code-delegate
```

Reload Claude Code, then optionally link the wrappers onto your PATH:

```
! cc-delegate link
```

Now `cc-delegate` and `cc-delegate-keys` work from any terminal.

## Configure

### TEXT mode (and AGENTIC’s API key)

`cc-delegate-keys` walks you through the keys. **A single OpenRouter key covers every model in the fleet.** SiliconFlow is optional (used as fallback for `kimi`, `deepseek`, and `glm` models only).

**Provider routing:** The model registry (`models.json`) routes via **OpenRouter** (primary — used by every model) and **SiliconFlow** (fallback only for `kimi`/`deepseek`/`glm`). The transport layer also supports **DeepInfra** and **Cerebras**, but they are not currently mapped to any model in the registry — they are available to wire up by adding provider entries to `models.json` if desired.

> **Run this in your own terminal — NOT inside a Claude Code `!` command.** The key must not pass through an agent's session. Keys are stored only in `~/.claude/cc-delegate/.env` (chmod 600) and never leave your machine except as the `Authorization` header to the provider you configured.

```
cc-delegate-keys        # in Terminal / Warp / iTerm, not in Claude Code
```

Prefer not to use the CLI? Add the line directly to `~/.claude/cc-delegate/.env`:
```
OPENROUTER_API_KEY=sk-or-...
```

### AGENTIC mode (additionally)

The `opencode` CLI must be installed:

```
npm i -g opencode-ai
```

The same OpenRouter key is used — no new account. Verify readiness with:

```
! cc-delegate setup
```

Example output:

```
agentic: opencode v1.2.3  … ready
openrouter: sk-or-v1-…  … ready
```

## Model matrix

| Alias          | Model                          | ★ | Anthropic‑equivalent  | Context  | $/1M in / $/1M out |
| -------------- | ------------------------------ | --- | --------------------- | -------- | ------------------- |
| `qwen`         | Qwen3‑Coder‑Next               | 3   | < Sonnet 4.5          | 262 144  | $0.11 / $0.80       |
| `kimi`         | Kimi K3                        | 5   | ≈ Opus 4.8            | 1 000 000| $3.00 / $15.00      |
| `kimi-fast`    | Kimi K3 (fast)                 | 4   | ≈ Sonnet 5            | 1 000 000| $3.00 / $15.00      |
| `deepseek`     | DeepSeek V4‑Flash              | 2   | ≈ Haiku 4.5           | 1 000 000| $0.09 / $0.18       |
| `deepseek-pro` | DeepSeek V4‑Pro                | 4   | ≈ Sonnet 5 (claimed)  | 1 000 000| $0.435 / $0.87      |
| `grok`         | Grok 4.5                       | 4   | ≈ Opus 4.8            | 500 000  | $2.00 / $6.00       |
| `glm`          | GLM‑5.2                        | 4   | ≈ Sonnet 5            | 1 048 576| $0.79 / $2.48       |

**Benchmark caveat:** Most vendor SWE‑bench numbers above 75% are self‑reported. The only independently verified result is GLM‑5.2’s SWE‑bench Pro 62.1% (morphlm‑verified).

## Usage


### Blocking await (`await`)

Block until one or more background jobs reach a terminal state (completed, failed, cancelled, or incomplete). Prints the result of each job and exits with a code indicating the outcome.

```
cc-delegate await <jobId> [<jobId> ...] [--timeout <sec>] [--json]
cc-delegate task --await [--timeout <sec>] --model <m> "<brief>"  # fused: dispatch + await
```

**Exit codes:**
| Code | Meaning |
|------|---------|
| 0 | All jobs completed successfully |
| 20 | One or more jobs failed |
| 21 | One or more jobs incomplete (partial result stored) |
| 22 | One or more jobs cancelled |
| 23 | Timeout reached (job still running — not cancelled) |

For multiple jobs, the worst code wins: failed(20) > incomplete(21) > cancelled(22) > timeout(23) > completed(0).

**Flags:**
- `--timeout <sec>`: Exit after N seconds if still running (default: infinite). This is the **total wall-clock timeout** across all awaited jobs — not a per-job limit.
- `--json`: Print result as JSON (7 fields: jobId, status, result, costUsd, elapsedMs, model, provider). Note: when used with `task --await --json`, the output is **the await payload** (the 7 fields above), not the task-dispatch JSON.

**Examples:**
```
# Await a single job
cc-delegate await task-abc123def456 --json

# Await multiple jobs; exit with worst outcome
cc-delegate await job1 job2 job3

# Dispatch + await (fused convenience)
cc-delegate task --await --model qwen --timeout 60 "write unit tests"

# Inside a background harness: capture the result and exit code
cc-delegate await <id> --json | jq . && echo "Job done"
```

**Pattern:** Run `cc-delegate await <id> --json` inside a harness background shell so the harness fires its native 'background task finished' notification only when the job is genuinely terminal — no polling required.


### Jobs panel (`jobs`)

`cc-delegate jobs` opens an interactive panel of recent delegation jobs (up to 30). Running/queued jobs sort to the top; within each group, most recent first. A dimmed column header row (STATUS · ID · MODEL · MODE · ELAPSED · TASK) sits below the title bar.

**Interactive keys:** `↑`/`↓` select a job · `enter` opens its detail view (streams live log when running) · `r` reloads · `f` cycles a status filter: `all → running → completed → failed → all` (active filter shown in title bar; filtering is over the already-loaded list, no refetch) · `q` quits.

**Non-interactive output:** `cc-delegate jobs --static` prints a snapshot table (with header) to stdout; `--json` emits machine-readable rows.

```
cc-delegate jobs
cc-delegate jobs --static
cc-delegate jobs --json
```


### TEXT mode examples

```
/cc-delegate:task "write unit tests for src/parser.ts"
/cc-delegate:deepseek "review this commit for security bugs" --diff
/cc-delegate:glm "refactor this module to async/await" --file src/**/*.ts
/cc-delegate:task --model kimi-fast --background "run a full audit of all auth paths"
```

Background tasks can be checked with `/cc-delegate:status`, fetched with `/cc-delegate:result`, and cancelled with `/cc-delegate:cancel`. Resume a previous thread:

```
/cc-delegate:task --resume last "add edge‑case tests for the invalid‑input flow"
```

### AGENTIC mode examples

```
/cc-delegate:task --agentic --model deepseek \
  "read the error handling in api/routes.ts and rewrite it to use Either"
/cc-delegate:task --agentic --write "apply the casing fixes I described in docs/naming.md"
```

### Isolated writes (`--isolate`)

`--isolate` (agentic `--write` only) runs the job inside a **throwaway git worktree** branched from `HEAD`, carrying your current tracked changes. Afterwards only *that job's own patch* is merged back into your working tree — a merge conflict is reported loudly and the patch is left un‑applied (saved on the job as `jobPatch`) instead of clobbering anything. Use it when a delegated write must not risk corrupting unrelated in‑progress work.

```
/cc-delegate:task --agentic --write --isolate --model glm "fix the failing test in api/"
```

### Orchestrator mode (`orchestrate`)

`cc-delegate orchestrate` moves the *coordination itself* off your expensive session model. A delegated **orchestrator** model decomposes the work (or you hand it a task list), runs each task on a **worker** model in its own isolated worktree, reviews each result, and merges back only clean + passing patches. It **never self‑approves** — failures, conflicts and low‑confidence reviews come back on a "requires your review" list, and the report splits cost by orchestrator vs workers.

```
# one brief, auto‑decomposed:
cc-delegate orchestrate --orchestrator-model kimi-fast --worker-model deepseek-pro \
  "migrate the logging module to structured logs and make the build pass"

# or an explicit task list:
cc-delegate orchestrate --tasks tasks.json     # [{ "title": "...", "brief": "...", "model": "qwen" }]
```

Workers run **in parallel** — each task is an isolated OpenCode session pinned to its own git worktree (`?directory=`), all on the one shared server, so N workers execute concurrently without corrupting each other. Review and merge‑back happen sequentially afterward. `--sequential` forces one‑at‑a‑time if needed. You remain the final verifier: merged patches are in your tree for review, flagged ones are not.

Resume reuses the native OpenCode session, retaining full tool‑call history. Manage the OpenCode backend directly:

```
cc-delegate opencode status
cc-delegate opencode stop
```

## Commands reference

### Slash commands

| Command | Description |
| --- | --- |
| `/cc-delegate:task` | Delegate a bounded coding sub‑task (model / provider picked explicitly) |
| `/cc-delegate:qwen` | Delegate to Qwen — high‑volume codegen, refactors and test writing |
| `/cc-delegate:kimi` | Delegate to Kimi — long‑context audit and deep reasoning |
| `/cc-delegate:kimi-fast` | Delegate to Kimi (fast) — faster, cheaper deep‑model calls |
| `/cc-delegate:deepseek` | Delegate to DeepSeek — fast debugging and diff review |
| `/cc-delegate:deepseek-pro` | Delegate to DeepSeek V4‑Pro — flagship‑grade codegen at low cost |
| `/cc-delegate:glm` | Delegate to GLM — multi‑step agentic refactors |
| `/cc-delegate:grok` | Delegate to Grok — frontier generalist reasoning and coding second opinions |
| `/cc-delegate:status` | Show active / recent delegation jobs for this repository |
| `/cc-delegate:jobs` | Snapshot of every job plus what each running one is doing right now |
| `/cc-delegate:result` | Show the stored final output for a finished job |
| `/cc-delegate:cancel` | Cancel an active background delegation job |
| `/cc-delegate:usage` | Show token and cost usage of delegations (interactive TUI when piped) |
| `/cc-delegate:review` | Run a rigorous correctness review on the working‑tree changes |
| `/cc-delegate:adversarial-review` | Adversarial review — actively try to break the change |
| `/cc-delegate:analyze` | Run a cost / spend analysis with text‑vs‑agentic split |
| `/cc-delegate:setup` | Check runtime readiness and which provider API keys are configured |

### CLI subcommands (after `cc-delegate link`)

| Subcommand | Description |
| --- | --- |
| `setup` | Check runtime readiness |
| `models` | Print model matrix (`--guide` for provider guide) |
| `task` | Dispatch a delegation (accepts `--agentic`, `--write`, `--isolate`, `--background`, etc.) |
| `orchestrate` | Delegated‑model orchestrator: fan out bounded tasks to isolated workers, review, merge clean patches back (`--orchestrator-model`, `--worker-model`, `--tasks`) |
| `status` | Show job status |
| `result` | Print a finished job’s output |
| `cancel` | Cancel a running job |
| `usage` | Print aggregated usage or launch the TUI |
| `review` | Run a correctness review (CLI‑friendly) |
| `adversarial-review` | Run an adversarial review |
| `analysis` | Show or save an analysis |
| `gate` | Set review‑gate policy (`off`, `warn`, `enforce`) |
| `opencode` | Manage the agentic OpenCode backend (`status`, `stop`) |
| `jobs` | Interactive panel: browse jobs, ↑/↓ select, enter to open one and watch it live (`--static` for a snapshot) |
| `slot` | Inspect the agentic run slot; `--release` clears a wedged/stale lock (`--force` if the holder is still alive) |
| `reconcile` | Cross-check ledger spend vs OpenRouter's own usage (`--set-baseline` for delta tracking); lists `unconfirmed` failed-but-maybe-billed rows |
| `reap` | Find stale (dead/abandoned) jobs across all workspaces and mark them terminal (`--dry-run`, `--json`) |
| `link` | Install the global `cc-delegate` / `cc-delegate-keys` wrappers |
| `uninstall` | Stop the OpenCode server and remove wrappers (`--purge` also deletes data) |

## Review & gate

- `/cc-delegate:review` runs a structured correctness review on the current working‑tree diff, returning a JSON verdict (pass / changes‑needed / fail).
- `/cc-delegate:adversarial-review` takes an adversarial stance, actively trying to break the change.

`cc-delegate gate` controls what happens before Claude finishes the turn:

| Setting     | Behaviour |
| ----------- | --------- |
| `off`       | No pre‑finish check |
| `warn`      | Show the review verdict, but allow the turn to finish |
| `enforce`   | Block finishing until the latest review returns `pass` |

When `enforce` is active, the Stop hook halts the turn until a passing review is available.

## Monitoring

- **TUI:** `cc-delegate usage` (without flags) opens an interactive tabbed viewer — Overview / Details / Health / Quotas / Analyze. `←`/`→` or `1`‑`5` switch tabs, `g` cycles the mode scope (all / text / agentic) across every tab, `r` reloads, `q`/Esc exits.
- **Ledger:** Every provider response appends a JSONL record to `~/.claude/cc-delegate/usage.jsonl` — job id, model, provider, tokens, cost, latency, context‑window usage, and mode.
- **How cost is measured (accurate):** text‑mode calls use the provider's actual billed cost when it reports one (OpenRouter returns it), otherwise a registry estimate; cached input tokens are priced at their cheaper rate. Agentic runs sum the cost of **every** tool‑loop turn in the session (not just the final message), and a run that billed tokens before failing still records its real cost. Provider account balances are shown in `cc-delegate setup` (real OpenRouter credits + SiliconFlow balance) — the true gate for paid calls.
- **Reset the dashboard:** `cc-delegate usage --reset` clears all history and starts fresh. In a terminal it first asks whether to export the current history to CSV (`~/.claude/cc-delegate/usage-export-<time>.csv`); non‑interactively use `--reset --yes` (add `--export` to save the CSV first).
- **Quotas:** `cc-delegate-keys` sets optional monthly USD caps per provider. Crossing 80% shows `⚠`, 100% `🔴`. Informational only — delegations are never blocked.
- **Circuit‑breaker:** After each task the runtime checks (model, provider) health over the last 20 entries. A degraded pair prepends a `⚡ circuit‑breaker advisory` ending with the exact retry flags (`→ retry: --model X --provider Y`).
- **Context guard:** Fails fast if the prompt clearly exceeds the model’s context window; warns at ≥70% usage with `⚠ context`.
- **Live agentic progress:** `cc-delegate watch <job-id>` tails a running agentic job's tool activity (files read, commands run, edits).
- **Stale job detection:** `cc-delegate usage` and `cc-delegate status` surface `stale: N (dead pid / abandoned — reap: cc-delegate reap)` when jobs are stuck as running/queued but their worker process is dead. `cc-delegate reap` finds these zombie jobs across all workspaces and marks them terminal; use `--dry-run` to preview, `--json` for machine-readable output.
- **Jobs panel (see what a delegation is doing):** delegated jobs run through Bash, so Claude Code does not render them the way it renders its own subagents — without this you are blind to a running job. `cc-delegate jobs` opens an interactive panel: `↑`/`↓` select a job, **`enter` opens it** and streams its live log and tool activity, `←`/Esc goes back, `r` reloads, `q` quits. Where output is captured (inside Claude Code, or `/cc-delegate:jobs`) it prints a static snapshot of every job **plus the live detail of each running one** — costing the orchestrator no context. The ACTIVITY section fills in as OpenCode reports a turn's tool parts (only once that turn completes); the LOG section is the reliable second‑by‑second signal.
- **Spend split:** The TUI’s Overview and `cc-delegate usage --details --json` report text‑vs‑agentic cost separately (`usage --details --mode agentic` shows the agentic table with agent, reasoning, cache and tool‑call columns).

## Codex equivalence

Migrating from [codex‑plugin‑cc](https://github.com/openai/codex-plugin-cc):

| codex‑plugin‑cc        | cc‑delegate                    |
| ---------------------- | ------------------------------ |
| `/codex:rescue`        | `/cc-delegate:task`            |
| `/codex:review`        | `/cc-delegate:review`          |
| `/codex:adversarial-review` | `/cc-delegate:adversarial-review` |
| `/codex:status`        | `/cc-delegate:status`          |
| `/codex:result`        | `/cc-delegate:result`          |
| `/codex:cancel`        | `/cc-delegate:cancel`          |
| `/codex:setup`         | `/cc-delegate:setup`           |

What cc‑delegate adds over codex:
- A whole model **fleet** with cost‑tiered aliases
- **Fallback** across providers
- **Cost accounting** with text/agentic split
- **Health** monitoring per model/provider
- **Spend quotas** and alerts
- **Circuit‑breaker** advisories
- **Context‑window guard**
- **Agentic mode** that mirrors codex’s tool delegation — but uses your own OpenRouter key and cheap external models

## How it works

A single companion runtime (`plugins/cc-delegate/scripts/companion.mjs`) handles every slash command and CLI subcommand. Background jobs detach and persist state in `~/.claude/cc-delegate/`, so monitoring works across restarts. TEXT mode sends a prompt to a provider API and returns text. AGENTIC mode launches a local OpenCode server that the runtime drives with tool‑use instructions; the server stops when idle. All usage lands in the JSONL ledger.

## Using with plan‑big‑execute‑small

The [`plan-big-execute-small`](https://github.com/NightZpy/claude-skills/blob/main/plan-big-execute-small/SKILL.md) skill splits work into Claude subagents and Codex tasks. cc‑delegate adds a third, cheaper executor fleet:
- Pure‑generation steps → TEXT mode
- Steps needing repo access, commands, or edits → AGENTIC mode
- Always honour circuit‑breaker and context advisories when dispatching the next step.

## Security

- Keys live only in `~/.claude/cc-delegate/.env`, written `chmod 600`, never committed.
- `cc-delegate-keys` uses hidden input — pasted values are masked.
- Every display shows only a masked hint (`first8…last4`), never the full key.
- Agentic mode’s OpenCode password file is restricted to `0600`.
- Nothing leaves your machine except the API calls to the providers you configure.

## Uninstall

1. `/plugin uninstall cc-delegate@claude-code-delegate`
2. From the terminal: `cc-delegate uninstall` (stops the OpenCode server and removes the `~/.local/bin` wrappers; add `--purge` to also delete `~/.claude/cc-delegate` — keys, ledger, and analyses).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
