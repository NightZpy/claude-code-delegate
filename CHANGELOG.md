# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
