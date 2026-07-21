---
name: frontier-runtime
description: Internal helper contract for calling the frontier-companion runtime from Claude Code
user-invocable: false
---

# Frontier Runtime

Use this skill only inside the `frontier:frontier-runner` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/frontier-companion.mjs" task ...`

Execution rules:
- The runner subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `curl`, direct provider API calls, or any other Bash activity.
- Do not call `setup`, `models`, `status`, `result`, or `cancel` from `frontier:frontier-runner`.
- Never invoke `task-worker` directly — it is an internal implementation detail of `task --background`.

Available flags on `task`:
- `--background` — run the delegated task asynchronously and print a `jobId` instead of waiting for the result.
- `--model <alias>` — route to a specific model alias (`qwen`, `kimi`, `deepseek`, `glm`).
- `--provider <openrouter|siliconflow|deepinfra|cerebras>` — pin a specific provider.
- `--file <path>` (repeatable) — inline a file's contents as context.
- `--diff` — inline `git diff HEAD` as context.
- `--system <txt>` — override the system prompt.
- `--max-tokens N` — cap output tokens.
- `--prompt-file <path>` — read the prompt from a file instead of the CLI argument.
- `--json` — emit machine-readable output.

Command selection:
- Use exactly one `task` invocation per delegation.
- Pass `--model`, `--provider`, and `--background` as separate flags; never fold them into the natural-language prompt text.
- Use `--file` for every file the brief names as context; do not read or inline file contents yourself.
- Use `--diff` when the brief asks to review or reason about the current working changes.
- Prefer `--background` for long-running, open-ended, or multi-step delegations. Prefer foreground for small, clearly bounded ones.

Safety rules:
- Never print or echo API keys (`OPENROUTER_API_KEY`, `SILICONFLOW_API_KEY`, `DEEPINFRA_API_KEY`, `CEREBRAS_API_KEY`) or the contents of `~/.claude/frontier/.env`.
- Never execute `task-worker` — it is internal only.
- If `setup` reports `ready: false` (surfaced via a `task` error), do not attempt to work around it. Return the error and tell the user to run `/frontier:setup`.
- Preserve the brief's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or the runtime cannot be invoked, return nothing.
