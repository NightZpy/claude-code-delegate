---
name: using-cc-delegate
description: Use when deciding whether/how to delegate a coding sub-task to cheap external models via cc-delegate — picking text vs agentic mode, choosing the model by task type and cost, writing an effective brief, and reading usage/health/quota/advisory signals.
---

# using-cc-delegate

You are the orchestrator. cc-delegate runs bounded sub-tasks on cheap frontier models (Qwen, DeepSeek, GLM, Kimi, Grok) so your own expensive context is spent on planning, judgment, and integration — not on typing execution.

**Core economics:** the win is keeping raw material out of YOUR context. Heavy reading (large files, logs, long diffs, codebase sweeps) should happen in the delegate, which returns distilled results. If the raw material ends up back in your context, you paid to orchestrate for nothing.

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

**Rule:** if a brief + the files/diffs you attach suffice, use TEXT. Reach for AGENTIC only when the step genuinely needs read/run/edit on disk. `--write` only when edits are wanted (default is read-only).

## 3. WHICH model — cheapest that clears the bar
| Task type | Model | Tier |
|---|---|---|
| Bulk boilerplate, cheap debugging, diff review | `deepseek` | ~Haiku |
| High-volume codegen, refactors, tests | `qwen` | ~Sonnet (low) |
| Demanding codegen at best price | `deepseek-pro` | ~Sonnet 5 |
| Agentic/complex refactor, tool use | `glm` | ~Sonnet 5 |
| Fast deep reasoning, long-context audit | `kimi-fast` | ~Sonnet 5 |
| Hardest judgment, security audit (expensive — reserve it) | `kimi` | ~Opus 4.8 |
| Second opinion / generalist | `grok` | ~Opus |

Start at the cheapest plausible tier; escalate only on a clear quality gap. Reserve `kimi` (full thinking) for what only an Opus-class model could do.

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

## 6. Read the signals
- **Cost/usage:** `/cc-delegate:usage` (TUI — tabs Overview/Details/Health/Quotas/Analyze; `g` scopes text/agentic) or `/cc-delegate:analyze` for an AI cost/health readout.
- **Circuit-breaker advisory** in task output (`⚡ …degraded…`): the model+provider pair is unhealthy; take the ranked suggestion on your next dispatch.
- **Quota alert** (`⚠` ≥80% / `🔴` 100%): non-blocking, but slow down or switch provider.
- **Context-guard failure:** prompt exceeds the model's window → pick a larger-context model (`kimi-fast`, `glm`, `deepseek` = 1M) or trim.
- **Degraded/failed delegation:** report it and decide — do NOT silently redo the work yourself as if it succeeded.

## 7. Review loop — and STOP before applying
- `/cc-delegate:review` → structured verdict (`pass`/`fail`) + findings on the working-tree diff; `/cc-delegate:adversarial-review` actively tries to break it.
- `cc-delegate gate enforce` makes review mandatory (Stop hook blocks finishing until a review passes).
- **After a review, STOP.** Present findings ordered by severity and ask which to fix. Never auto-apply review fixes, even obvious ones, without confirmation.

## Golden rules
- Brief is self-contained — the delegate can't see your context.
- TEXT first; AGENTIC only for real read/run/edit needs (100× cost).
- Cheapest model that clears the bar; escalate on evidence, not by default.
- Keep raw material in the delegate, not in your context — that's the whole point.
- Apply and verify delegated output yourself; you are the judge.
- Honor advisories: degraded → switch, quota → slow, overflow → bigger context.
