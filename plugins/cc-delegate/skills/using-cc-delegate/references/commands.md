# cc-delegate command reference

Exhaustive, code-grounded reference. Every flag and behavior described here comes from the companion entrypoint (`scripts/companion.mjs`) and its argument parser (`lib/args.mjs`).

---

## The two modes

| | TEXT (default) | AGENTIC (`--agentic`) |
|---|---|---|
| **How** | One API completion call | Local OpenCode HTTP server; full tool loop |
| **Tools** | None — prompt in → text/code out | Read files, run commands, edit files (`--write`) |
| **Cost** | ~$0.0001/req | ~100× TEXT (harness overhead + multi-turn billing) |
| **When** | Pure generation, boilerplate, mechanical refactors of provided code, diff review, long-context analysis — anything you can self-contain in a brief + `--file`/`--diff` | Steps that must traverse the repo, run commands, or apply edits in place |

**`--write` (agentic only):** allows the model to edit files on disk. Without it, agentic runs read-only. A `--write` job that changes nothing on disk fails with `NO-OP WRITE` — the model returned code in prose instead of applying it. Completed writes report `applied (real diff) — files changed: …` grounded in the actual git diff, and flag `⚠ CLAIMED-BUT-NOT-APPLIED` when the prose mentions files it didn't actually change.

**`--isolate` (agentic `--write`):** runs the job in a throwaway git worktree; only that job's own patch is merged back. A merge conflict is reported (patch saved on the job) instead of clobbering the working tree.

---

## Subcommands (grouped)

### Dispatch

| Command | Purpose | Key flags |
|---|---|---|
| `task` | Dispatch one bounded sub-task (text or agentic) | `--model`, `--agentic`, `--write`, `--isolate`, `--background`, `--await`, `--file`, `--diff`, `--resume`, `--system`, `--max-tokens`, `--call-timeout`, `--json` |
| `orchestrate` | Delegate coordination of a fan-out of worker jobs | `--orchestrator-model`, `--worker-model`, `--tasks`, `--max`, `--sequential`, `--json` |

#### `task` — one bounded sub-task

Usage: `cc-delegate task [flags] "<brief>"` (brief also via `--prompt-file` or stdin)

| Flag | Description |
|---|---|
| `--model <alias>` | `qwen`|`deepseek`|`deepseek-pro`|`glm`|`kimi`|`kimi-fast`|`grok` (default `qwen`) |
| `--provider <name>` | Force a specific provider (`openrouter`|`siliconflow`|`deepinfra`|`cerebras`); otherwise the model's chain |
| `--agentic` | Run on local OpenCode server with real tools (read/run/edit) |
| `--write` | (agentic) Allow file edits; default is read-only |
| `--isolate` | (agentic `--write`) Isolated git worktree; merge only this job's patch back |
| `--file <path>` | Attach a file as context (repeatable) |
| `--diff` | Attach `git diff HEAD` as context |
| `--resume <jobId\|last>` | Continue a previous job's conversation thread |
| `--background` | Run detached; prints `{jobId}`; collect with `status`/`result`/`await` |
| `--await` | Dispatch + block until terminal; implies `--background`; exits by outcome code |
| `--system <text>` | Override the system prompt |
| `--max-tokens <n>` | Cap output tokens |
| `--call-timeout <sec>` | Max seconds for one model call (agentic only; default 900) |
| `--json` | Machine-readable output |

**Fused dispatch+block:** `cc-delegate task --await [--timeout <sec>] --model X "<brief>"` — dispatches, blocks until terminal, prints the result, and exits with an outcome code (0=completed, 20=failed, 21=incomplete, 22=cancelled, 23=timeout). `--timeout` returns without cancelling the job.

#### `orchestrate` — delegated fan-out coordination

Usage: `cc-delegate orchestrate [flags] "<one big brief>"` or `cc-delegate orchestrate --tasks tasks.json`

An orchestrator model (default `kimi-fast`) plans/decomposes; each task runs on a worker model (default `deepseek-pro`) in its OWN isolated git worktree, in parallel (each an isolated OpenCode session on one shared server). The orchestrator reviews results and only clean+passing patches are merged back. It never self-approves — you stay the final verifier.

| Flag | Description |
|---|---|
| `--orchestrator-model <alias>` | Planner + reviewer model (default `kimi-fast`) |
| `--worker-model <alias>` | Default executor per task (default `deepseek-pro`) |
| `--tasks <path>` | JSON array `[{title, brief, model?}]`; else decompose the brief |
| `--max <n>` | Cap number of tasks (default 8) |
| `--sequential` | Run workers one-at-a-time instead of in parallel |
| `--json` | Print the full report as JSON |
| `--prompt-file <path>` | Read the brief from a file |

---

### Collect & monitor

| Command | Purpose | Key flags |
|---|---|---|
| `status` | Show running jobs and recent history | `--all`, `--json` |
| `await` | Block until job(s) reach terminal state, then print result | `--timeout <sec>`, `--json` |
| `watch` | Stream live activity for a running job | (none) |
| `jobs` | Browse all jobs; interactive panel with live detail | `--static`, `--json` |
| `result` | Print the full output/saved result of a finished job | `--json` |

#### `status`

`cc-delegate status [<jobId>] [--all] [--json]`

- No arg: prints running count + recent jobs (last 8).
- With `<jobId>`: detailed status of one job, including log tail and agentic activity.
- `--all`: show all jobs, not just recent 8.

#### `await` — block until terminal

`cc-delegate await <jobId> [<jobId>...] [--timeout <sec>] [--json]`

Blocks until each job reaches a terminal state (completed/failed/cancelled). Prints the result (same content as `result`). Exits with the worst outcome code across all jobs:

| Exit code | Meaning |
|---|---|
| 0 | Completed |
| 20 | Failed |
| 21 | Incomplete (some files modified before failure) |
| 22 | Cancelled |
| 23 | Timeout (still running — NOT cancelled) |

Multi-job: returns the worst code. `--json` emits `{jobId, status, result, costUsd, elapsedMs, model, provider}` per job (single job = object, multi-job = array). `--timeout` returns without cancelling the job — it is still running.

**Economics advantage:** run `await` in a background shell — the harness fires its native "background task finished" notification only when the job is genuinely terminal (file-watch, zero polling). No orchestrator forwarder turn is burned.

#### `watch`

`cc-delegate watch <jobId>`

Streams live tool activity and log output for a running agentic/text job. Polls every 2 seconds; exits when the job reaches a terminal state.

#### `jobs`

`cc-delegate jobs [--static] [--json]`

Interactive TUI panel (in a real terminal): ↑/↓ select job · enter to open detail and watch live tool activity + log · ←/esc back · r reload · q quit. When output is captured (piped / inside Claude Code) it prints a static snapshot of all jobs plus the live activity of every running one. `--static` forces the snapshot even in a terminal.

#### `result`

`cc-delegate result [<jobId>] [--json]`

Prints the full output (model response text or error) of a finished job. With no `<jobId>`, prints the latest finished job. Includes context/quota/health advisory prefix and `--write` trust-gate annotations.

---

### Cost & health

| Command | Purpose | Key flags |
|---|---|---|
| `usage` | Cost dashboard (interactive TUI with 5 tabs) | `--details`, `--health`, `--json`, `--static`, `--days`, `--model`, `--provider`, `--session`, `--mode`, `--limit`, `--reset`, `--yes`, `--export` |
| `analysis` | Save/retrieve AI-powered usage analysis | sub: `save` (reads stdin), `show [--json]` |
| `reconcile` | Cross-check ledger spend against OpenRouter's actual usage | `--set-baseline`, `--json` |

#### `usage`

Interactive TUI (5 tabs: Overview, Details, Health, Quotas, Analyze). Tabs: ←/→ or 1-5 · r reload · g toggle mode scope (all→text→agentic) · q quit.

Static views:
- `--details`: recent rows table (last 20; `--limit N` for more)
- `--health`: success %, latency p95, fallback rates, active advisories
- `--json`: machine-readable aggregate
- `--reset --yes [--export]`: purge all usage history

Filters: `--days N`, `--model <alias>`, `--provider <name>`, `--session current`, `--mode text|agentic`.

#### `analysis`

- `cc-delegate analysis save` — reads AI analysis text from stdin; stores it.
- `cc-delegate analysis show [--json]` — prints the last saved analysis with its timestamp.

#### `reconcile`

`cc-delegate reconcile [--set-baseline] [--json]`

OpenRouter's `/credits` reports cumulative usage; this command diffs spend-since-baseline against our ledger. Orphaned spend (failed/aborted calls that billed but weren't recorded) surfaces as a positive delta. Also lists `unconfirmed` rows — calls that reached a provider and failed, which MAY have billed — with their request ids for cross-checking in OpenRouter's Activity log.

---

### Review

| Command | Purpose | Key flags |
|---|---|---|
| `review` | Delegated code review of working-tree diff | `--model` (default `deepseek`), `--json` |
| `adversarial-review` | Actively tries to break the diff | `--model` (default `glm`), `--json` |
| `gate` | Toggle stop-review-gate: off | warn | enforce | status | (positional) |

#### `review` / `adversarial-review`

`cc-delegate review [--model <alias>] [--json]`
`cc-delegate adversarial-review [--model <alias>] [--json]`

Runs a text-mode task with `--diff` and a schema-constrained system prompt that demands a JSON verdict (`pass`/`fail`) with structured findings. `adversarial-review` uses a stricter prompt designed to actively find breakage; defaults to `glm` instead of `deepseek`. Both return exit code 0 for pass, 1 for fail.

#### `gate`

`cc-delegate gate <off|warn|enforce|status>`

Controls the stop-review-gate that blocks finishing a Claude Code turn until a review passes. Default: `off`.

---

### Setup & administration

| Command | Purpose | Key flags |
|---|---|---|
| `setup` | Print readiness report (keys, agentic, quotas, credits) | `--json` |
| `models` | List available model aliases with providers | `--guide`, `--json` |
| `link` | Install shell wrappers to `~/.local/bin` | (none) |
| `slot` | Inspect or release the agentic run slot | `--release`, `--force`, `--json` |
| `opencode` | Inspect/stop the OpenCode server | sub: `status [--json]`, `stop` |
| `uninstall` | Remove wrappers + optionally purge all state | `--purge` |

#### `setup`

`cc-delegate setup [--json]`

Reports: whether at least one provider key is present; each provider's key status and quota; OpenRouter account credits; SiliconFlow balance; and agentic (OpenCode) installation/version/server status. This is the preflight check — run once per session.

#### `models`

`cc-delegate models [--guide] [--json]`

Lists every model alias with its providers, context window, tier, and notes. `--guide` prints a provider routing reference table.

#### `link`

`cc-delegate link`

Creates `cc-delegate` and `cc-delegate-keys` shell wrappers in `~/.local/bin` pointing to the latest installed version. Warns if `~/.local/bin` is not on PATH.

#### `slot`

`cc-delegate slot [--release] [--force] [--json]`

Agentic jobs serialize on a single lock. Inspect the current holder, or release a dead/stale holder. `--release` refuses to release a live holder unless `--force` is passed.

#### `opencode`

`cc-delegate opencode status [--json]` — installed version + server health.
`cc-delegate opencode stop` — stops the OpenCode server if running.

#### `uninstall`

`cc-delegate uninstall [--purge]`

Stops the OpenCode server, removes `~/.local/bin` wrappers. With `--purge`, also deletes `~/.claude/cc-delegate/` (keys, ledger, saved analyses) and lean agent definitions.

---

### Internal

| Command | Purpose |
|---|---|
| `task-worker` | Internal: background worker entrypoint (requires `--job-id`) |

---

## Key cross-cutting flags

| Flag | What it does | Accepted by |
|---|---|---|
| `--model <alias>` | Pick the model: `qwen`|`deepseek`|`deepseek-pro`|`glm`|`kimi`|`kimi-fast`|`grok` | `task`, `review`, `adversarial-review`, `orchestrate` (`--orchestrator-model`, `--worker-model`) |
| `--provider <name>` | Force a specific provider route (`openrouter`|`siliconflow`|`deepinfra`|`cerebras`) | `task` |
| `--background` | Dispatch via a background worker; return `{jobId}` immediately | `task` |
| `--agentic` | Run on a local OpenCode server with real tools | `task` |
| `--write` | (agentic) Allow file edits on disk | `task` |
| `--isolate` | (agentic --write) Run in a throwaway git worktree | `task` |
| `--file <path>` | Attach a file as context (repeatable) | `task` |
| `--diff` | Attach `git diff HEAD` as context; also used internally by `review` | `task`, `review` (implicit) |
| `--resume <jobId\|last>` | Continue a previous job's conversation thread; `last` = most recently completed | `task` |
| `--json` | Machine-readable JSON output on stdout | `setup`, `models`, `task`, `orchestrate`, `status`, `result`, `await`, `jobs`, `usage`, `analysis show`, `review`, `adversarial-review`, `reconcile`, `slot` |
| `--timeout <sec>` | (await) Return without cancelling after N seconds | `await` |
| `--prompt-file <path>` | Read the brief/task prompt from a file (exact round-trip, no shell escaping issues) | `task`, `orchestrate` |