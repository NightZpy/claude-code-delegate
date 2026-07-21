---
description: Delegate a bounded coding sub-task to an external frontier model via the frontier-runner subagent
argument-hint: '[--model qwen|kimi|deepseek|glm] [--provider openrouter|siliconflow|deepinfra|cerebras] [--background] <brief>'
allowed-tools: Agent
---

Invoke the `frontier:frontier-runner` subagent via the `Agent` tool (`subagent_type: "frontier:frontier-runner"`), forwarding the raw user request as the prompt.

Raw user request:
$ARGUMENTS

The final user-visible response must be the frontier-runner's output verbatim. Do not paraphrase, summarize, rewrite, or add commentary before or after it.

If the user did not supply a brief, ask what the external model should do.
