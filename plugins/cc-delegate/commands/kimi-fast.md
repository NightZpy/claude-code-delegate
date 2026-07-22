---
description: Delegate to Kimi K3 with low reasoning effort — faster and cheaper deep-model calls
argument-hint: '[--provider openrouter|siliconflow|deepinfra|cerebras] [--background] <brief>'
allowed-tools: Agent
---

Invoke the `cc-delegate:runner` subagent via the `Agent` tool (`subagent_type: "cc-delegate:runner"`), forwarding `--model kimi-fast` followed by the raw user request as the prompt.

Raw user request:
$ARGUMENTS

The final user-visible response must be the runner's output verbatim. Do not paraphrase, summarize, rewrite, or add commentary before or after it.

If the user did not supply a brief, ask what Kimi should do.
