---
description: Delegate to Grok — frontier generalist reasoning and coding second opinions
argument-hint: '[--provider openrouter] [--background] <brief>'
allowed-tools: Agent
---

Invoke the `frontier:frontier-runner` subagent via the `Agent` tool (`subagent_type: "frontier:frontier-runner"`), forwarding `--model grok` followed by the raw user request as the prompt.

Raw user request:
$ARGUMENTS

The final user-visible response must be the frontier-runner's output verbatim. Do not paraphrase, summarize, rewrite, or add commentary before or after it.

If the user did not supply a brief, ask what Grok should do.
