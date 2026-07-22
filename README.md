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

`cc-delegate-keys` walks you through the keys. **A single OpenRouter key covers every model in the fleet.** SiliconFlow is optional.

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
| `task` | Dispatch a delegation (accepts `--agentic`, `--write`, `--background`, etc.) |
| `status` | Show job status |
| `result` | Print a finished job’s output |
| `cancel` | Cancel a running job |
| `usage` | Print aggregated usage or launch the TUI |
| `review` | Run a correctness review (CLI‑friendly) |
| `adversarial-review` | Run an adversarial review |
| `analysis` | Show or save an analysis |
| `gate` | Set review‑gate policy (`off`, `warn`, `enforce`) |
| `opencode` | Manage the agentic OpenCode backend (`status`, `stop`) |
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

- **TUI:** `cc-delegate usage` (without flags) opens an interactive tabbed viewer — Overview / Details / Health / Quotas / Analyze. `←`/`→` or `1`‑`5` switch tabs, `m` filters by mode (text / agentic), `r` reloads, `q`/Esc exits.
- **Ledger:** Every provider response appends a JSONL record to `~/.claude/cc-delegate/usage.jsonl` — job id, model, provider, tokens, cost, latency, context‑window usage, and mode.
- **Quotas:** `cc-delegate-keys` sets optional monthly USD caps per provider. Crossing 80% shows `⚠`, 100% `🔴`. Informational only — delegations are never blocked.
- **Circuit‑breaker:** After each task the runtime checks (model, provider) health over the last 20 entries. A degraded pair prepends a `⚡ circuit‑breaker advisory` with ranked fallback suggestions.
- **Context guard:** Fails fast if the prompt clearly exceeds the model’s context window; warns at ≥70% usage with `⚠ context`.
- **Spend split:** The TUI’s Overview and `cc-delegate usage --details --json` report text‑vs‑agentic cost separately.

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
