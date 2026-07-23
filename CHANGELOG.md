# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.18.0] - 2026-07-23

### Changed
- **`orchestrate` now runs workers in PARALLEL, natively on OpenCode.** Each task is an isolated OpenCode session pinned to its own git worktree via the server's `?directory=` param (verified empirically: writes land in the session's directory), so N workers execute concurrently on the one shared server — no per-worker server/port, no `process.chdir`. Review and merge-back stay sequential. `--sequential` forces the old one-at-a-time path. This replaces the sequential-with-server-recycle design; the whole-run global lock is now held once around the fan-out instead of per worker.
- Each parallel worker is recorded in the usage ledger (accurate per-worker cost/tokens); the orchestrator-vs-worker cost split includes the plan call.

### Added
- `lib/agentic-parallel.mjs` (dependency-injected, self-tested) — the concurrent worker engine: one shared server, one session+worktree per task, all cleaned up.

## [0.17.1] - 2026-07-23

### Changed
- `using-cc-delegate` skill now tells agents about the self-healing agentic slot (`slot` / `slot --release`) and `reconcile` / `unconfirmed` rows, so orchestrators recognize a wedged slot and the cost-reconciliation signals.

## [0.17.0] - 2026-07-23

### Added
- **Cost reconciliation to catch orphaned spend.** `cc-delegate reconcile` cross-checks our ledger against OpenRouter's own cumulative usage (`/credits`); with `--set-baseline` it tracks the since-baseline delta so spend OpenRouter billed but we didn't record surfaces as a positive "unreconciled" amount. (OpenRouter's per-window analytics endpoint 404s for inference keys, so the baseline-delta approach is used instead.)
- Text-mode calls now capture OpenRouter's `X-Generation-Id` **response header** (present even on error responses, and more reliable than the body `id`). A call that reached a provider and then FAILED now records its request id and is flagged `unconfirmed: true` in the ledger — a failed-but-maybe-billed call no longer orphans its spend. `reconcile` lists these rows with ids/timestamps for manual cross-check against OpenRouter's Activity log.

### Note
- Per-sub-call id capture for agentic runs, and the OpenCode-native parallel orchestrator, are the next planned steps.

## [0.16.2] - 2026-07-23

### Fixed
- **Stale agentic lock deadlock.** A crashed agentic job (OOM, provider 402, killed process) left its run-lock behind, and the only cleanup was a 46-minute mtime timeout — so every subsequent agentic job blocked for up to 46 minutes on a phantom holder. The slot is now reclaimed by **liveness** (`process.kill(pid, 0)`): a dead holder's lock is stolen in milliseconds. The lock is also released on abnormal exit (SIGTERM/SIGINT/uncaughtException/exit), not only in the normal `finally`.

### Added
- The lock now stores `{pid, startedAt, jobId}`; `cc-delegate status` shows the agentic slot holder (and flags a STALE dead holder), and the "waiting for the agentic slot" message names the holder.
- `cc-delegate slot` — inspect the agentic run slot; `slot --release` clears a wedged lock (`--force` to release even a live holder).

## [0.16.1] - 2026-07-23

### Added
- Ledger rows now record the provider-side request id (`providerRequestId`) for text-mode calls — OpenRouter `gen-…`, SiliconFlow `chatcmpl-…` — so a billed call can be reconciled against the provider's own activity/billing log instead of orphaning our cost tracking. Absent on no-response timeouts (no id exists), where provider + timestamp still allow a manual cross-check; agentic-mode capture is a follow-up.

## [0.16.0] - 2026-07-23

### Added
- `task --agentic --write --isolate`: run a delegated write inside a throwaway git worktree (branched from HEAD, carrying tracked changes), then merge back only that job's own patch. A merge conflict is reported and the patch saved on the job (`jobPatch`) instead of clobbering the working tree.
- `orchestrate` subcommand: a delegated orchestrator model decomposes work (or takes `--tasks`), runs each task on a worker model in its own isolated worktree, reviews each result, and merges back only clean + passing patches. Returns per-task status, a "requires your review" list, and an orchestrator-vs-worker cost split. Never self-approves; workers run sequentially (v1).
- `lib/worktree.mjs` and `lib/orchestrate.mjs`, each with a runnable `--selftest`.

### Fixed
- The usage TUI Details tab now shows in-flight (running/queued) jobs, which live in job state and never in the ledger — previously only finished jobs appeared.

## [0.15.6] - 2026-07-22

### Fixed
- Direct (text-mode) OpenRouter calls now send `HTTP-Referer` and `X-Title`, so cc-delegate is attributed in OpenRouter's "Top Apps" ranking instead of showing up as "Unknown".

## [0.15.5] - 2026-07-22

### Added
- The usage TUI footer now shows the reset command and where history + CSV exports live (`~/.claude/cc-delegate/`).

## [0.15.3] - 2026-07-22

### Changed
- `usage --reset` clears all history and starts fresh. In a terminal it asks whether to export the current history to CSV first (`usage-export-<time>.csv`); non-interactively use `--reset --yes` (add `--export` to save the CSV).
## [0.15.2] - 2026-07-22

### Added
- `usage --reset`: archive the ledger to a timestamped `.bak` and start clean. Pre-fix rows (before the 0.15.0 cost-accounting fixes) can't be recomputed retroactively — per-turn spend wasn't stored — so a reset is the honest way to get an accurate dashboard going forward. Old data is preserved as a backup, never deleted.
## [0.15.1] - 2026-07-22

### Fixed (cost accounting — OpenRouter reconciliation)
- Text-mode cost now uses the provider's ACTUAL billed cost when reported (OpenRouter returns `usage.cost` when the request sets `usage: { include: true }`), instead of a registry estimate — so recorded cost matches OpenRouter's own logs exactly. Registry pricing remains the fallback for providers that don't report cost. (The account-level `/activity` API needs a management key, so per-call actual cost is the reliable reconciliation path.)
## [0.15.0] - 2026-07-22

### Fixed (cost accounting — a ~17x under-count)
- **Agentic cost is now summed over the whole tool loop.** An agentic run makes a separate billed model call for each read/bash/edit turn; we were recording only the FINAL message's cost. Now the ledger sums cost + tokens across every assistant turn in the session (verified against a real SiliconFlow bill: our ledger read $0.33 where the provider charged $5.69). The final-message figure is logged alongside for reference.
- **Failed-but-billed runs are now recorded.** A run that consumed tokens before failing (timeout/empty/rejection after partial work) records its real billed cost to the ledger instead of $0 — provider spend is no longer invisible.
- **Cached input tokens are priced at their (cheaper) rate** when the provider reports `cached_tokens`, using the registry's per-provider `cachedInput` price, instead of charging every prompt token at the full input rate.

## [0.14.0] - 2026-07-22

### Added
- **Agentic provider failover.** If a model's primary provider rejects a call for a *no-spend* reason (out of credits / quota / balance / max_tokens / 402·403·429), the run now fails over to the same model on the next provider in its chain, and only reports failure when every provider rejects (the error lists each). It deliberately does NOT fail over on timeouts or ambiguous errors — the call may have run and billed, so retrying elsewhere would double-spend.
- Balance pre-check: providers already known to be out of balance are skipped before dispatch (saves a doomed call). `setup` now shows real OpenRouter credits AND SiliconFlow balance.

## [0.13.2] - 2026-07-22

### Added
- `setup` now shows the REAL OpenRouter account credit balance (`GET /credits`), not just our internal ledger quota — e.g. `openrouter account credits: $-0.07 remaining ($100.07 of $100.00 used) 🔴 OUT — top up to run paid models`. This is the true gate for paid calls (an exhausted balance is exactly why pricier agentic models, which reserve ~32k output tokens, get rejected while our quota tracker still reads "ok"). Best-effort, additive `openrouterCredits` in `--json`.

### Notes
- The reported quota-percentage bug (530%/220%) is not present in current code — `setup`/usage render it correctly (5%/2%); a stale cached plugin version showed the old value. `/reload-plugins` resolves it.
## [0.13.1] - 2026-07-22

### Fixed
- Agentic runs now surface the provider's real error. OpenCode returns HTTP 200 with the provider error tucked in `info.error` (e.g. OpenRouter "requires more credits, or fewer max_tokens" — pricier models request ~32k output tokens and can exceed a low key balance/limit while cheap models fit). Previously this looked like a generic "empty response"; now the actual actionable message is reported. (This was mis-diagnosed as a reasoning-model parsing bug; the real cause is credit/limit + max_tokens.)

## [0.13.0] - 2026-07-22

### Fixed (agentic reliability — from two field reports)
- **300s invisible timeout removed.** Agentic message calls now use `node:http` (not global fetch, whose undici default capped calls at 300s and surfaced as a bogus "fetch failed"). Default agentic call budget raised to 15 min; per-call `--call-timeout <sec>` flag; timeout errors now say "model call exceeded Ns".
- **No more false `completed`.** An empty agentic response (no text, no tool calls) is now treated as failed instead of a silent empty success. Background-worker stderr (incl. an import/parse crash) is captured into the job log, so a broken runtime is visible in `status`/`result` instead of vanishing.
- **Partial `--write` work is salvaged.** On failure, files the run actually modified (diffed against a pre-run snapshot — no longer the whole dirty tree) are reported and the job is marked `incomplete`, not `failed`, so the orchestrator neither doubles the edits nor discards good work.
- **`touched files` now lists only the job's changes**, computed against a baseline snapshot — not the entire working tree.
- Latent crash fixed: `stopServerLocked` was referenced but never defined (fired when a healthy server existed in another cwd).
- Retry no longer repeats a timed-out call identically (fails fast on timeouts; retries only connection errors).

### Docs
- `--prompt-file` documented as the safe way to pass long briefs (inline shell args mangle backticks/`$`/newlines); confirmed working in agentic mode.

## [0.12.0] - 2026-07-22

### Fixed
- **Concurrent agentic jobs no longer kill each other.** Agentic runs now hold a run-level lock for the whole server+session+message phase (they share one OpenCode server); a second job queues instead of invalidating the first's session. Retries once on a dropped session and fails with a real message (session + URL + `--provider` hint) instead of an opaque "fetch failed".
- `task --help` / subcommand help now prints flags (incl. `--provider`, `--agentic`, `--write`, `--resume`) instead of erroring.

### Changed
- Circuit-breaker advisories are now copy-paste actionable: each suggestion ends with `→ retry: --model X --provider Y`. Documented that `--provider <name>` forces a route (text and agentic) in the using-cc-delegate skill, plus a "be proactive — never fire-and-forget" rule (always collect/inspect background jobs; act on advisories).

## [0.11.6] - 2026-07-22

### Security
- Key-setup guidance no longer routes API keys through the Claude Code terminal: the `using-cc-delegate` skill, `/cc-delegate:setup`, and the README now direct the user to run key setup in a SEPARATE terminal (or edit `~/.claude/cc-delegate/.env` directly), never via a `! ` command where the pasted key would be visible to the model.

## [0.11.5] - 2026-07-22

### Fixed
- Link-independent setup/keys paths use a semver sort (not lexical `ls|tail`, which wrongly picked 0.9.0 over 0.11.x).
- Preflight/setup guidance no longer assumes the short `cc-delegate` CLI is linked: check readiness via the `/cc-delegate:setup` slash command, and key setup uses a link-independent `node .../setup-keys.mjs` invocation (the bare `cc-delegate-keys` only exists after `cc-delegate link`). Documented slash-vs-CLI in the skill.

## [0.11.3] - 2026-07-22

### Changed
- `using-cc-delegate`: added a Preflight section — check `cc-delegate setup --json` once before delegating; if not ready, point the user to `! cc-delegate-keys` (and `npm i -g opencode-ai` for agentic) instead of failing on the first task.

## [0.11.2] - 2026-07-22

### Changed
- `using-cc-delegate`: sharpened the TEXT vs AGENTIC decision — a 3-question YES/NO rule (discover files? run commands? edit in place?) plus paired same-task examples, clarifying that attaching files via `--file`/`--diff` is TEXT and agentic is only for exploring/acting on the tree.

## [0.11.1] - 2026-07-22

### Changed
- `using-cc-delegate` skill: added the three-tier delegation intensity (high-power/balanced/economy driven by Claude usage) and re-grounded model selection in the Anthropic-equivalence table (map the step to a Claude tier → cheapest cc-delegate model at that tier, with prices).

## [0.11.0] - 2026-07-22

### Added
- `using-cc-delegate` skill (model-invocable): ships the decision logic with the plugin so any agent can pick text vs agentic, choose the model by task type/cost, write an effective brief (prompt contract), read usage/health/quota/advisory signals, and run the review loop — no external orchestration skill required.

## [0.10.0] - 2026-07-22

### Added
- Global mode dimension in the usage TUI: press `g` to scope every tab (Overview/Details/Health/Quotas/Analyze) to all/text/agentic, shown as a prominent `mode: [ all ] · text · agentic` badge; empty scopes say "no <mode> delegations yet" instead of a blank table.
- `watch <jobId>`: live `tail -f`-style view of a running job — for agentic jobs it streams the model's tool activity (files read, commands run, edits) polled from the OpenCode session; falls back to the job log. `status` shows recent agentic activity inline.

## [0.9.1] - 2026-07-22

### Changed
- README reorganized: TEXT vs AGENTIC modes cleanly separated (comparison table, per-mode configuration and examples), model matrix, codex-equivalence mapping, review/gate and monitoring sections.

## [0.9.0] - 2026-07-22

### Added
- **Review suite**: `review [--adversarial] [--model]` delegates a working-tree diff review returning a structured JSON verdict (schema + prompt templates); `/cc-delegate:review` and `/cc-delegate:adversarial-review` commands.
- **Review gate**: `gate <off|warn|enforce|status>` + Stop hook — with `enforce`, Claude can't finish while uncommitted changes fail a delegated review (fail-open on any error).
- Mode-aware TUI: Details tab filters by mode ('m' key), Health/Quotas/Analyze split text vs agentic spend.
- SessionEnd hook: sweeps orphaned running/queued jobs from ended Claude sessions.

## [0.8.1] - 2026-07-22

### Added
- Agentic observability: `usage --details --mode <text|agentic>` with an agentic-focused table (AGENT, REASON, CACHE-R, TOOLS, FILES), reasoning/cache/tool-call/touched-count fields on agentic ledger rows, `byMode` totals in `usage --json`, and an "agentic spend vs text" line in the overview.

### Fixed
- Agentic sessions now follow the task's working directory (server recycled on cwd change); fresh-task wrong-cwd bug caught in live testing.

## [0.8.0] - 2026-07-22

### Added
- **Agentic mode**: `task --agentic [--write]` runs delegates on a local OpenCode server with real tools (read/edit files, run commands); per-task model selection, native session resume, `touched files` reporting via git, ledger rows with `mode: agentic` and actual billed cost. Requires the opencode CLI (`npm i -g opencode-ai`).
- Lean `cc-plan`/`cc-build` agents (~27% less harness overhead than stock opencode agents; measured 12,969 → 9,464 input tokens).
- `opencode status|stop` and `uninstall [--purge]` subcommands; setup reports agentic availability; MODE column in `usage --details`; codex→cc-delegate command-mapping docs.

### Fixed
- Review fixes: touched-files agent check, authenticated health probes, foreign-server guard via raw probe (401-aware), stop-before-state-removal ordering, ensure lock against concurrent spawns, lean-agent content updates on upgrade, cross-cwd agentic resume refused, purge removes lean agents, empty-stream guard in providers, state file written 0600.

## [0.7.1] - 2026-07-21

### Added
- SSE streaming for all provider calls (`stream: true` + `include_usage`) — fixes SiliconFlow edge hangs on long non-streamed generations (verified live) and guards the whole stream with the per-model timeout.
- `kimi-fast` alias: same Kimi K3 weights with `reasoning_effort: low` — seconds instead of minutes for quick deep-model calls; `requestParams` supported per model in the registry.

## [0.7.0] - 2026-07-21

### Added
- Per-model request timeout (`timeoutMs` in the registry); kimi set to 30 min — slow always-on-thinking reasoners legitimately exceed the 10-min default on long tasks.
- Agent-comprehension doc fixes from a real field audit (run by the plugin itself): documented `setup --json` shape, background vs foreground output formats, status/result bridge after background dispatch, precise `--resume` semantics.

### Notes
- SiliconFlow deepseek/kimi chat routes observed hanging while GLM answers instantly (same key, valid IDs) — capacity-side; the health monitor and circuit-breaker advisories handle demotion dynamically, so routes stay as fallbacks.

## [0.6.1] - 2026-07-21

### Changed
- `models --guide` (and the guide shown by `cc-delegate-keys`) replaced with a "Models × providers" comparison matrix: quality stars, compact context, and per-provider $/1M in/out side by side, with the model's own version string (from the primary provider's id) shown next to each alias and provider-specific variant ids called out when they differ. Degrades by dropping provider columns right-to-left on narrow terminals instead of wrapping.
- `deepseek`'s DeepInfra route (the older V3.2-Exp model) removed from `config/models.json`; `deepseek` now routes through OpenRouter and SiliconFlow only, both serving V4-Flash.
- `setup-keys.mjs` skips the key/quota prompt entirely for providers with no route in the model registry (DeepInfra today); an already-stored key for such a provider is kept in the `.env` untouched, and the remaining prompt steps renumber accordingly.

## [0.6.0] - 2026-07-21

### Added
- `task --resume <jobId|last>`: iterative thread direction — the orchestrator can send follow-ups without repacking context; conversation persisted per job, `resumedFrom` in status/result, context guard measures the full resent thread, 2M-char pruning keeps system + recent turns (alternation-safe marker).

### Fixed
- `--resume last` picks the most recently completed job (a running background job no longer shadows the resumable thread).

## [0.5.3] - 2026-07-21

### Fixed
- Static TTY views (`--details`/`--health`) clip to terminal width (no wrapping); Analyze tab metric is now "top model by spend" (was misleading job-count tie).

## [0.5.2] - 2026-07-21

### Fixed
- Removed duplicate `clipVisible` declaration that broke 0.5.1.

## [0.5.1] - 2026-07-21

### Changed
- All user-facing strings and code comments in English; ANSI-aware line clipping in the TUI.

## [0.5.0] - 2026-07-21

### Added
- Circuit-breaker advisories: after each task, checks the health of the (model, provider) pair over its last 20 ledger entries and prepends ranked switch suggestions when it looks degraded.
- Context-window guard: fail-fast when a prompt clearly won't fit a model's context, plus a non-blocking advisory at ≥70% usage; new `CTX%` column in usage details.
- Analyze tab in the `usage` TUI, showing a local no-AI mini-summary plus the last analysis persisted via `analysis save`/`analysis show`.

### Fixed
- `setup-keys.mjs` no longer exits silently on a closed/non-interactive stdin (EOF); pending prompts now resolve as an explicit "skipped".
- Underlined table headers in TUI/CLI table output for better readability.

### Changed
- Renamed plugin/commands/CLI from frontier to cc-delegate (matching the repo); data dir migrates automatically from ~/.claude/frontier.

## [0.4.0]

### Added
- Interactive tabbed usage TUI (Overview / Details / Health / Quotas / Analyze), replacing the previous flat usage printout.
- Full visual redesign of CLI/TUI output.
- `cachedInput` pricing field in the model registry for providers that support cached-context discounts.

## [0.3.2]

### Fixed
- Semver comparison bug in the `frontier link` version-resolving wrapper.

## [0.3.1]

### Added
- `frontier link`: installs `frontier`/`frontier-keys` wrappers into `~/.local/bin` so both commands work from any terminal.
- Views footer in `usage` output.

## [0.3.0]

### Added
- Monitoring release: redesigned `usage` output, `--details` and `--health` views.
- Monthly spend quotas per provider with non-blocking `⚠`/`🔴` alerts.
- Provider price/verdict guide (`models --guide`, shared with `frontier-keys`).
- `/frontier:analyze`: subagent-driven cost/health analysis over usage/details/health JSON.

## [0.2.1]

### Added
- Hidden (masked) key input in `frontier-keys`.
- Verified SiliconFlow fallback routes for Kimi and DeepSeek.

## [0.2.0]

### Added
- Usage ledger (`~/.claude/frontier/usage.jsonl`) with per-model, per-provider, and per-session stats.
- Per-Claude-session usage attribution via a `SessionStart` hook.
- `frontier`/`frontier-keys` bin shims for short PATH commands.

## [0.1.0]

### Added
- Initial release: companion runtime, model fleet (Qwen, Kimi, DeepSeek, GLM, Grok), slash commands, `frontier-runner` subagent, interactive key setup.
