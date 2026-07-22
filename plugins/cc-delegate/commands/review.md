---
description: Run a rigorous correctness review on the current working-tree changes via a delegated model
argument-hint: '[--adversarial] [--model deepseek|glm|qwen] [--json] [focus...]'
allowed-tools: Agent
---

Invoke the `cc-delegate:runner` subagent via the `Agent` tool (`subagent_type: "cc-delegate:runner"`), forwarding the raw user request as the prompt.

Raw user request:
$ARGUMENTS

The runner subagent must execute the command `node plugins/cc-delegate/scripts/companion.mjs review $ARGUMENTS` in the current working directory and return the output verbatim. Do not alter or summarize.
