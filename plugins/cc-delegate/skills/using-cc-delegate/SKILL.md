---
name: using-cc-delegate
description: Use when deciding whether/how to delegate a coding sub-task to cheap external models via cc-delegate — picking text vs agentic mode, choosing the model by task type and cost, writing an effective brief, and reading usage/health/quota/advisory signals.
---

# using-cc-delegate

You are the orchestrator. cc-delegate runs bounded sub-tasks on cheap frontier models (Qwen, DeepSeek, GLM, Kimi, Grok) so your own expensive context is spent on planning, judgment, and integration — not on typing execution.

**Core economics:** the win is keeping raw material out of YOUR context. Heavy reading (large files, logs, long diffs, codebase sweeps) should happen in the delegate, which returns distilled results. If the raw material ends up back in your context, you paid to orchestrate for nothing.

## Preflight — check it's ready (once, before the first delegation)
Check readiness with the slash command **`/cc-delegate:setup`** (it works anywhere — it calls the runtime via the plugin root, no PATH setup needed). Read its JSON:
- `ready: true` with a provider `keyPresent`/`active` → text mode is good to go.
- `ready: false` (no keys) → the user configures a key once. **SECURITY — the key must NOT pass through Claude Code's terminal.** Do NOT tell them to run key setup with the `! ` prefix here (the pasted key would enter this session and be visible to you). Instead tell them to do ONE of:
  - **In their own separate terminal** (Terminal / Warp / iTerm — not this Claude Code session), run the interactive setup: `node "$HOME/.claude/plugins/cache/claude-code-delegate/cc-delegate/$(ls ~/.claude/plugins/cache/claude-code-delegate/cc-delegate | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)/scripts/setup-keys.mjs"` (or `cc-delegate-keys` if linked). One OpenRouter key covers every model.
  - **Or edit the env file directly**, themselves: add `OPENROUTER_API_KEY=sk-or-...` to `~/.claude/cc-delegate/.env` (`chmod 600`).
  Until a key exists, don't delegate — do the work yourself or wait. Never ask the user to paste a key into this conversation or a `! ` command.
- Agentic: read the additive `agentic: {installed, version, serverRunning}` block. `installed: false` → tell the user `npm i -g opencode-ai` enables `--agentic`; stick to text mode meanwhile.

**Short CLI vs slash commands.** Inside Claude Code, prefer the slash commands (`/cc-delegate:task`, `:usage`, `:status`, …) — they always work. The bare `cc-delegate …` shell commands shown later only exist after a one-time `cc-delegate link` (installs wrappers to `~/.local/bin`, which must be on PATH). If `cc-delegate: command not found`, either run link once (`! node "$HOME/.claude/plugins/cache/claude-code-delegate/cc-delegate/$(ls ~/.claude/plugins/cache/claude-code-delegate/cc-delegate | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)/scripts/companion.mjs" link`) or just use the slash commands.

Don't re-check per task — once per session is enough.

## 0. Delegation intensity — scale it to your Claude budget
How much you delegate should track how close you are to your Claude Code usage limit (and how few days to reset). You can't read your exact `/usage`, so infer it from harness usage warnings and what the user tells you.

- **High-power** (plenty of budget): do the substantive work yourself; delegate only clear wins — bulk boilerplate, mechanical transforms, and long-material reads that would bloat your context.
- **Balanced** (default): you orchestrate and do the genuinely hard thinking; delegate all bounded execution, standard codegen, refactors, tests, diff review, and heavy reads.
- **Economy** (near the limit / warnings): delegate everything that possibly can be — even judgment steps go to `kimi`/`deepseek-pro` with all material via `--file`; you drop to minimal supervisor (plan once, read distilled results, short verdicts) to make the plan last until reset.

Claude Code stays the orchestrator and the thinker for the hardest parts in every tier; only the amount pushed down changes.

## 1. Should you delegate at all?
Delegate bounded, well-specifiable steps. Keep architecture calls, ambiguous specs, security-critical judgment, and anything needing your full session context.

**Test:** Can you write the entire task as a self-contained brief — all needed code inline or via `--file` — that a model with no memory of this session could execute? Yes → delegate. No → do it yourself.

## 2. TEXT vs AGENTIC (the key call — default TEXT)

| | TEXT (default) | AGENTIC (`--agentic`) |
|---|---|---|
| How | One completion call | Local OpenCode server; full tool loop |
| Tools | None (prompt in → text out) | Read files, run commands, edit (`--write`) |
| Cost | ~$0.0001/req | ~100× TEXT (harness overhead) |
| Use for | Pure generation, boilerplate, tests, mechanical refactor of *provided* code, diff review, long-context analysis — anything a self-contained brief + `--file`/`--diff` carries | Steps that must traverse the repo, run commands, or apply edits in place |

**The crisp rule.** Use **AGENTIC only if you answer YES to any of these** — otherwise TEXT:
1. The delegate must **discover which files** to touch itself (you can't name them up front).
2. The delegate must **run commands** (tests, build, grep across the tree) to do the task.
3. The delegate must **apply edits in place** across the repo (`--write`).

If you can name the files and paste/attach them, and you only need code or a diff back, it's **TEXT** — even for multi-file work. Attaching files with `--file`/`--diff` is TEXT, not agentic; agentic is for when the model has to *explore or act on* the working tree by itself.

Same task, both modes:
- "Review this diff for bugs" → **TEXT** `--diff`. · "Find what's causing the failing test and fix it" → **AGENTIC --write** (must run the test, hunt the cause, edit).
- "Write tests for `parser.ts`" (you attach it) → **TEXT** `--file`. · "Add tests for every exported function in `src/`" (must enumerate them) → **AGENTIC**.
- "Rewrite this function to use Either" (pasted) → **TEXT**. · "Migrate the whole module to Either and make the build pass" → **AGENTIC --write**.

`--write` only when you actually want edits applied; without it, agentic runs read-only. AGENTIC costs ~100× — never use it for what a TEXT brief + attached context can do.

## 3. WHICH model — map the task to a Claude tier, then pick the cheapest model at that tier
The base is the Anthropic-equivalence of each model (same table `cc-delegate models` prints). First ask "what Claude model would this step need?", then pick the cheapest cc-delegate model at that capability tier. `$` = per 1M tokens in/out.

| If the step needs… | Claude equiv | Model(s) — cheapest first | $ in/out |
|---|---|---|---|
| Cheap bulk: boilerplate, mechanical edits of provided code, quick debug, diff review | **Haiku 4.5** | `deepseek` | $0.09 / $0.18 |
| High-volume codegen / refactors / tests (below-Sonnet is fine) | just under Sonnet | `qwen` | $0.11 / $0.80 |
| Solid Sonnet-grade work: non-trivial codegen, real refactors, larger suites | **Sonnet 5** | `deepseek-pro` → `glm` (agentic/tool-use) → `kimi-fast` (fast deep reasoning) | $0.44/$0.87 · $0.79/$2.48 · $3/$15 |
| Opus-grade judgment: hardest reasoning, security audits, ambiguous specs | **Opus 4.8** | `grok` (cheaper) → `kimi` (deepest, reserve it) | $2/$6 · $3/$15 |

Rules: (1) pick the **cheapest model at the needed tier** — `deepseek-pro` before `glm` before `kimi-fast` for Sonnet-grade; `grok` before `kimi` for Opus-grade. (2) Don't over-buy: use an Opus-tier model only when the step truly needs Opus-level judgment. (3) Context: all except `qwen` (262K) and `grok` (500K) carry ~1M — for very long inputs prefer a 1M model. (4) `kimi` full-thinking is the priciest and slowest; it's the economy-mode substitute for Fable/Opus, not an everyday choice.

## 4. Write a brief that works (prompt contract)
Cheap models reward tight contracts far more than they reward a bigger model. For every delegation:
- **One clear task per run.** Split unrelated asks.
- **State what "done" looks like** — the exact end state and output shape. Don't assume it will infer it.
- **Inline all context** the task needs (code via `--file`, the diff via `--diff`); the delegate can't see your session.
- **Say what to return**: complete code, a unified diff, or a specific format — pick one and say so.
- Task-type add-ons: code/debug → ask for a verification note (does it compile / cover the cases); review → demand evidence-anchored findings, no speculation; write (agentic) → constrain it to the named change, no unrelated refactors.
- Iterate with `--resume last "<delta>"` — send only the change, not the whole brief again.

## 5. Dispatch
**TEXT:** `/cc-delegate:task --model deepseek --file src/parser.ts "write unit tests; return the complete test file"`
Background + collect + iterate:
```
/cc-delegate:task --model kimi-fast --background "audit auth flows across routes; list findings with file:line"
/cc-delegate:status            # or: cc-delegate watch <job-id>  for live activity
/cc-delegate:result <job-id>
/cc-delegate:task --resume last "now add regression tests for finding #2"
```
**AGENTIC:** `/cc-delegate:task --agentic --model glm "read api/routes.ts and report the error-handling pattern"` · add `--write` to apply edits. Watch live tool activity with `cc-delegate watch <job-id>`.

**Isolated writes** — add `--isolate` to an agentic `--write` job to run it in a throwaway git worktree; only that job's own patch is merged back, and a conflict is reported (patch saved on the job) instead of clobbering. Use it whenever a delegated write could collide with unrelated in-progress work in the tree.

## 5b. Orchestrator mode — push coordination off your own context
When you'd otherwise hand-orchestrate several bounded tasks (decompose, dispatch, group by file zone, review each, retry), delegate the *coordination itself*: `cc-delegate orchestrate --orchestrator-model kimi-fast --worker-model deepseek-pro "<one big brief>"` (or `--tasks tasks.json`). A strong orchestrator model plans, runs each task on a worker in its **own** isolated worktree, reviews, and merges only clean+passing patches; it returns per-task status, a **requires-your-review** list, and an orchestrator-vs-worker cost split. It **never self-approves** — you stay the final verifier: review merged patches in your tree, handle the flagged ones. Reach for it in balanced/economy intensity when the coordination would burn your session tokens; skip it for one or two tasks (just dispatch them directly). Workers run sequentially (safe v1).

## 6. Read the signals
- **Cost/usage:** `/cc-delegate:usage` (TUI — tabs Overview/Details/Health/Quotas/Analyze; `g` scopes text/agentic) or `/cc-delegate:analyze` for an AI cost/health readout. `cc-delegate reconcile` cross-checks recorded spend against OpenRouter's actual usage (`--set-baseline` to track the delta) and lists `unconfirmed` rows — failed calls that reached a provider and MAY have billed.
- **Wedged agentic slot:** if a job hangs on "waiting for the agentic slot" but no job is really running, a crashed holder left a stale lock. It now self-reclaims in seconds (liveness check), but you can inspect/clear it immediately with `cc-delegate slot` / `cc-delegate slot --release`.
- **Circuit-breaker advisory** in task output (`⚡ …degraded…`): a model+provider pair is unhealthy. The advisory ends with the exact retry flags (`→ retry: --model X --provider Y`) — use them on your next dispatch. **`--provider <name>` forces a specific route** (e.g. `--provider siliconflow` when a model's OpenRouter route is degraded); it works in both text and agentic mode.
- **Quota alert** (`⚠` ≥80% / `🔴` 100%): non-blocking, but slow down or switch provider.
- **Context-guard failure:** prompt exceeds the model's window → pick a larger-context model (`kimi-fast`, `glm`, `deepseek` = 1M) or trim.
- **Degraded/failed delegation:** report it and decide — do NOT silently redo the work yourself as if it succeeded.
- **`agentic call rejected … requires more credits / insufficient balance`:** the provider account is out of spendable balance (agentic runs reserve ~32k output tokens, so pricier models hit this first). Agentic mode now **auto-fails-over**: if a model's primary provider rejects for a no-spend reason (credits/quota/limit), it retries the same model on the next provider in its chain, and only reports failure when ALL providers reject (the error lists each). It does NOT fail over on timeouts/ambiguous errors (the call may have run and billed). Check real balances with `/cc-delegate:setup` — it shows the actual OpenRouter credits and SiliconFlow balance, not just the internal quota. Fix by topping up a provider, or use a cheaper agentic model. (Text mode uses far fewer tokens, so the same model often still works there.)

## 7. Review loop — and STOP before applying
- `/cc-delegate:review` → structured verdict (`pass`/`fail`) + findings on the working-tree diff; `/cc-delegate:adversarial-review` actively tries to break it.
- `cc-delegate gate enforce` makes review mandatory (Stop hook blocks finishing until a review passes).
- **After a review, STOP.** Present findings ordered by severity and ask which to fix. Never auto-apply review fixes, even obvious ones, without confirmation.

## Be proactive — never fire-and-forget
After you dispatch, you MUST look at the outcome before doing anything else — especially for `--background` jobs. Don't assume success.
- Foreground: read the returned output/error immediately.
- Background: collect with `/cc-delegate:status` then `/cc-delegate:result <id>` (or `cc-delegate watch <id>` for live activity). Don't move on or report "done" until you've confirmed each job actually completed.
- On a **failed** job: read the error AND any `⚡` advisory, then act — re-dispatch on the healthy route (`--provider …` / a different `--model`), don't silently retry the same broken route or quietly redo the work yourself.
- Agentic jobs are **serialized** (they share one server) — launching several at once is fine, they queue; just remember to collect all of them.

## Pass long briefs via --prompt-file (not inline)
For any brief longer than a line or two, write it to a file and pass `--prompt-file <path>` (works in text AND agentic mode). Inline shell arguments are unsafe for briefs containing backticks, `$`, or newlines — the shell mangles them (e.g. a backticked `animation_spec` becomes command substitution and the model silently receives a brief with holes). `--prompt-file` round-trips the text exactly.

## Golden rules
- Brief is self-contained — the delegate can't see your context.
- TEXT first; AGENTIC only for real read/run/edit needs (100× cost).
- Cheapest model that clears the bar; escalate on evidence, not by default.
- Keep raw material in the delegate, not in your context — that's the whole point.
- Apply and verify delegated output yourself; you are the judge.
- Honor advisories: degraded → switch, quota → slow, overflow → bigger context.
