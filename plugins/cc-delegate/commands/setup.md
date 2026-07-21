---
description: Check runtime readiness and which frontier provider API keys are configured
argument-hint: ''
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup --json`

Present the setup output to the user. Each provider may include a `quota` object (`monthlyUsd`, `spentThisMonth`, `pct`, `level`) when a monthly spend quota is configured — mention it next to the key status, and flag `level: "warning"`/`"critical"` clearly.

If any required API key (`OPENROUTER_API_KEY`, `SILICONFLOW_API_KEY`, `DEEPINFRA_API_KEY`, `CEREBRAS_API_KEY`) is missing or the result reports `ready: false`:
- Tell the user to run the interactive key setup themselves, in their own terminal, since it needs their input:

```
! cc-delegate-keys
```

- Do not run `setup-keys.mjs` yourself — it is interactive and must be run by the user.
