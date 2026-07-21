# Anthropic-compatible endpoints (agentic mode research)

Verified July 21, 2026 against official provider docs. This is the groundwork for the
roadmap "agentic mode": running headless Claude Code (`claude -p`) with
`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` pointed at a provider, so an external model
inherits the full Claude Code harness (tools, agentic loop, repo access) while billing
the cheap provider instead of the Anthropic plan.

| Provider | Base URL | Key/plan | Models | Notes |
|---|---|---|---|---|
| DeepSeek | `https://api.deepseek.com/anthropic` | Normal API key | `deepseek-v4-pro`, `deepseek-v4-flash` (1M ctx) | Full tool use + streaming; auto-maps claude-opus→v4-pro, sonnet/haiku→v4-flash; `budget_tokens` silently ignored; `deepseek-chat/reasoner` retired 2026-07-24. **Easiest win.** |
| Moonshot (Kimi) | `https://api.moonshot.ai/anthropic` | Normal API key | Kimi K3 (default, 1M ctx), `kimi-k2.7-code(-highspeed)` | Native model names required (`ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_*_MODEL`); tool use + streaming work; fine-grained feature matrix not fully documented. |
| Z.ai (GLM) | `https://api.z.ai/api/anthropic` | **GLM Coding Plan required** — normal Z.ai key does NOT work | GLM-5.2 (+ `glm-5.2[1m]`), GLM-5-Turbo, 4.7, 4.5-Air | Maps claude-* via `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`; tool use, streaming, thinking levels supported. |
| DashScope (Qwen) | Changed: legacy `.../apps/claude-code-proxy` is deprecated/limited → current `.../apps/anthropic`, domain varies by region/plan (PAYG Singapore: `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com`; Coding Plan: `coding-intl.dashscope.aliyuncs.com`) | PAYG: normal key; Coding/Token Plan: dedicated key from its own console | `qwen3-coder-next/plus/flash`; Claude Code defaults use general `qwen3.6-plus/flash`, `qwen3.7-plus`, `qwen3.8-max-preview` | Native names required. Interleaved thinking undocumented. Blogs still circulate the legacy endpoint — ignore them. |
| OpenRouter | `https://openrouter.ai/api` (native "Anthropic skin") | Normal `sk-or-...` key (`ANTHROPIC_AUTH_TOKEN`, set `ANTHROPIC_API_KEY=""`) | Guaranteed only for Anthropic first-party models (`~anthropic/claude-*-latest`); open models "may work" but tool-calling can fail | For multi-vendor routing (incl. Grok) the de-facto path is [claude-code-router](https://github.com/musistudio/claude-code-router) (v3.0.15, active). |

## Implications for cc-delegate agentic mode

- Phase 1 candidates: **deepseek** and **kimi** (normal keys, official endpoints, full tool use).
- **glm** agentic requires the user to buy the GLM Coding Plan → gate behind explicit config.
- **qwen** agentic needs region/plan-aware endpoint config → later phase.
- **grok** agentic only via CCR proxy → out of scope for now.
- Text-mode (current v1 chat completions) remains the cheapest path for pure generation;
  agentic mode is for repo-heavy tasks under orchestrator direction.

Sources: docs.z.ai (claude, devpack), platform.kimi.ai/docs/guide/claude-code-kimi,
api-docs.deepseek.com (anthropic_api, claude_code, pricing), alibabacloud.com/help/en/model-studio
(claude-code, anthropic-api-messages), openrouter.ai (anthropic, claude-code-integration).
