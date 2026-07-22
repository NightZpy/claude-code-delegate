---
name: runtime
description: Internal helper contract for calling the cc-delegate companion runtime from Claude Code
user-invocable: false
---

# cc-delegate Runtime

Use this skill only inside the `cc-delegate:runner` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" task ...`

Execution rules:
- The runner subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `curl`, direct provider API calls, or any other Bash activity.
- Do not call `setup`, `models`, `status`, `result`, `cancel`, or `usage` from `cc-delegate:runner`.
- Never invoke `task-worker` directly — it is an internal implementation detail of `task --background`.

Available flags on `task`:
- `--background` — run the delegated task asynchronously. Prints a pretty-printed JSON object containing `"jobId"` (multi-line — parse it as JSON, do not grep single lines). Foreground tasks print the model response as plain text unless `--json` is passed.
- `--model <alias>` — route to a specific model alias (`qwen`, `kimi`, `deepseek`, `glm`).
- `--provider <openrouter|siliconflow|deepinfra|cerebras>` — pin a specific provider.
- `--file <path>` (repeatable) — inline a file's contents as context.
- `--diff` — inline `git diff HEAD` as context.
- `--system <txt>` — override the system prompt.
- `--max-tokens N` — cap output tokens.
- `--prompt-file <path>` — read the prompt from a file instead of the CLI argument.
- `--resume <jobId|last>` — continue a previous delegation thread: resends the stored conversation plus your new prompt to the same model. Only a `completed` job can be resumed (`failed`/`cancelled` cannot; `last` = most recently completed job in this workspace). The `jobId` comes from the background dispatch JSON or from `status`.
- `--json` — emit machine-readable output.

Command selection:
- Use exactly one `task` invocation per delegation.
- Pass `--model`, `--provider`, `--background`, and `--resume` as separate flags; never fold them into the natural-language prompt text.
- Use `--file` for every file the brief names as context; do not read or inline file contents yourself.
- Use `--diff` when the brief asks to review or reason about the current working changes.
- Prefer `--background` for long-running, open-ended, or multi-step delegations. Prefer foreground for small, clearly bounded ones.
- Use `--resume last` or `--resume <jobId>` when the brief asks to continue, follow up on, or iterate on a prior delegation instead of starting fresh.

Safety rules:
- Never print or echo API keys (`OPENROUTER_API_KEY`, `SILICONFLOW_API_KEY`, `DEEPINFRA_API_KEY`, `CEREBRAS_API_KEY`) or the contents of `~/.claude/cc-delegate/.env`.
- Never execute `task-worker` — it is internal only.
- If a `task` fails with "no API key configured", do not attempt to work around it. Return the error verbatim — it already names the missing providers and the exact `node .../setup-keys.mjs` command — and tell the user to run that command in their terminal, or to type it in the Claude Code prompt prefixed with `! ` so the interactive key setup runs in-session. `/cc-delegate:setup` shows current key status.
- Preserve the brief's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or the runtime cannot be invoked, return nothing.
