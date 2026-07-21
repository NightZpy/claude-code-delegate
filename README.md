# claude-code-delegate

A [Claude Code](https://claude.com/claude-code) plugin marketplace. Its one plugin, `frontier`, delegates bounded coding sub-tasks — boilerplate, tests, mechanical refactors, diff review, long-context analysis — from Claude Code to external frontier models (Qwen, Kimi, DeepSeek, GLM, Grok) over OpenAI-compatible APIs, so the expensive Claude context in your session is spent on planning and judgment rather than on generation. The architecture mirrors the `openai-codex` plugin: a companion runtime script, a thin forwarding subagent, and a set of slash commands.

## Why

Token economics. In a planner/executor split, the planner (Claude) reads the repo, makes decisions, and reviews results — that's where the expensive context belongs. The executor just turns a well-specified brief into code or a diff, and that job doesn't need a frontier-tier model to do it well. The models in the matrix below are 10-100x cheaper per token than Claude and, for bounded generation tasks, close the gap. Keeping the planner on Claude and pushing bulk generation onto cheaper external models cuts the cost of large or repetitive tasks without touching the quality of the parts that actually require judgment.

## Install

```
/plugin marketplace add NightZpy/claude-code-delegate
/plugin install frontier@claude-code-delegate
```

## Setup keys

Run the interactive key setup once, either in a regular terminal or from inside Claude Code with `!`:

```
node plugins/frontier/scripts/setup-keys.mjs
```

or, from a Claude Code session:

```
! node plugins/frontier/scripts/setup-keys.mjs
```

Input is visible as you type. Keys are written to `~/.claude/frontier/.env` with `chmod 600`. The runtime reads `process.env` first, then falls back to that file.

| Env var | Provider | Console URL |
|---|---|---|
| `OPENROUTER_API_KEY` | OpenRouter | https://openrouter.ai/keys |
| `SILICONFLOW_API_KEY` | SiliconFlow | https://cloud.siliconflow.cn/account/ak |
| `DEEPINFRA_API_KEY` | DeepInfra | https://deepinfra.com/dash/api_keys |
| `CEREBRAS_API_KEY` | Cerebras | https://cloud.cerebras.ai/platform/keys |

You don't need all four — the runtime falls back automatically between providers that support a given model alias.

## Model matrix

Data from research as of July 2026.

| Alias | Model (OpenRouter ID) | Role | Ctx | $/1M in/out | Rough equivalent | Notes |
|---|---|---|---|---|---|---|
| `qwen` | Qwen3-Coder-Next (`qwen/qwen3-coder-next`) | Bulk codegen, refactors, tests | 262K | $0.11 / $0.80 | ~Sonnet (low tier) / GPT-5.4 | Weak on terminal use (Terminal-Bench 36.2%); available on Cerebras (~2000 tok/s, vendor-claimed) |
| `deepseek` | DeepSeek V4-Flash (`deepseek/deepseek-v4-flash`) | Fast debugging, diff review, boilerplate | 1M | $0.09 / $0.18 | ~Haiku 4.5 / GPT-5.4-mini | Cheapest of the four; V3.2-Exp has the one independently verified aider score (74.5%, #5) |
| `glm` | GLM-5.2 (`z-ai/glm-5.2`) | Multi-step agentic refactoring, tool-use | 1M | $0.79 / $2.48 | ~Sonnet 5 / GPT-5.5 | Strongest independently verified result of the lot: SWE-bench Pro 62.1%, #1 open-weight (Morph LLM); Artificial Analysis Index 51 |
| `grok` | Grok 4.5 (`x-ai/grok-4.5`) | Frontier generalist, second opinions | 500K | $2.00 / $6.00 | ~Opus 4.8 / GPT-5.5 | xAI's latest (Jul 2026); OpenRouter only in v1 |
| `kimi` | Kimi K3 (`moonshotai/kimi-k3`) | Long-context auditing, deep reasoning | 1M | $3.00 / $15.00 | ~Opus 4.8 / GPT-5.5 | Artificial Analysis Index 57 (#4 global); expensive, slow (34 tok/s), always-on thinking is billed, frequent 429s |

**Benchmark caveat:** most of the vendor-reported SWE-bench figures above 75% for these models are self-reported and not confirmed on neutral leaderboards. The only independently verified numbers here are GLM-5.2's SWE-bench Pro result and DeepSeek V3.2-Exp's aider result.

## Commands

| Command | Description | Example |
|---|---|---|
| `/frontier:task` | Delegate a task, picking model/provider explicitly | `/frontier:task --model glm "refactor this module to use async/await"` |
| `/frontier:qwen` | Delegate to Qwen3-Coder-Next | `/frontier:qwen "write unit tests for src/parser.ts"` |
| `/frontier:grok` | Delegate to Grok 4.5 | `/frontier:grok "second opinion on this design"` |
| `/frontier:kimi` | Delegate to Kimi K3 | `/frontier:kimi --file src/**/*.ts "audit this module for race conditions"` |
| `/frontier:deepseek` | Delegate to DeepSeek V4-Flash | `/frontier:deepseek --diff "review this diff for bugs"` |
| `/frontier:glm` | Delegate to GLM-5.2 | `/frontier:glm "migrate this file from class components to hooks"` |
| `/frontier:status` | Check a background job's status | `/frontier:status <jobId>` |
| `/frontier:result` | Fetch a finished background job's output | `/frontier:result <jobId>` |
| `/frontier:cancel` | Cancel a running background job | `/frontier:cancel <jobId>` |
| `/frontier:usage` | Show aggregated token and cost usage across frontier delegations | `/frontier:usage --days 7 --model qwen --session current` |
| `/frontier:setup` | Check readiness (keys present, providers reachable) | `/frontier:setup` |

## How it works

All commands and the `frontier:frontier-runner` agent forward to a single companion runtime, `plugins/frontier/scripts/frontier-companion.mjs`:

```
frontier-companion.mjs setup [--json]
frontier-companion.mjs models
frontier-companion.mjs task [--background] [--model qwen|kimi|deepseek|glm|grok] [--provider openrouter|siliconflow|deepinfra|cerebras]
                             [--file <path>]... [--diff] [--system <txt>] [--max-tokens N]
                             [--prompt-file <path>] [--json] "<prompt>"
frontier-companion.mjs status
frontier-companion.mjs result
frontier-companion.mjs cancel
frontier-companion.mjs usage [--days N] [--model qwen|kimi|deepseek|glm|grok] [--session <id|current>] [--json]
```

- **Background jobs** run as a detached process, with state persisted to disk so `status`/`result`/`cancel` can be called from a later, unrelated Claude Code turn.
- **Context inlining**: `--file` and `--diff` read local content and fold it into the prompt sent to the external model — the model itself has no filesystem or tool access.
- **Provider fallback**: each model alias maps to one or more providers; if the pinned or default provider fails, the runtime retries against the next one that serves that model.
- **Cost tracking**: token usage and estimated cost are recorded per job.
- **Usage ledger**: every provider response appends one JSONL record to `~/.claude/frontier/usage.jsonl`, so spend can be inspected across workspaces with `/frontier:usage`.
- **Session breakdown**: usage is also grouped per Claude Code session via a `SessionStart` hook that stores `FRONTIER_SESSION_ID` in Claude's env file for later task processes.
- **State**: job state and the `.env` key file live under `~/.claude/frontier/`, outside the plugin and outside any project repo.

v1 is text-in/text-out: the external model has no tools and returns code or patches as text, which Claude then applies and verifies. There is no agentic loop in this version.

## Using with plan-big-execute-small

The `plan-big-execute-small` skill already splits execution between Claude subagents and Codex. `frontier` is a third, cheaper executor fleet for the same pattern: pure-generation steps that don't need tool access — bulk boilerplate, mechanical text refactors, test writing, diff review, very-long-context analysis — can go to a frontier model instead of a Claude or Codex subagent, with Claude (or a cheap subagent) still responsible for applying and verifying the output.

## Architecture

```
claude-code-delegate/
  .claude-plugin/
    marketplace.json
  plugins/
    frontier/
      .claude-plugin/
        plugin.json
      agents/
        frontier-runner.md          # thin forwarder subagent
      commands/
        task.md, qwen.md, kimi.md, deepseek.md, glm.md, grok.md
        status.md, result.md, cancel.md, usage.md, setup.md
      hooks/
        hooks.json                  # SessionStart hook to persist Claude session id
      scripts/
        frontier-companion.mjs      # runtime: task, status, result, cancel, usage, setup, models
        session-hook.mjs            # writes FRONTIER_SESSION_ID into Claude env file
        setup-keys.mjs              # interactive key setup
      skills/
        frontier-runtime/
          SKILL.md                  # internal call contract for frontier-runner
```

## Roadmap

- Agentic loop: give the external model bounded tool access instead of text-in/text-out.
- Streaming output for foreground tasks.
- Prompt caching discounts on DeepInfra once available.

## License

MIT — see [LICENSE](./LICENSE).
