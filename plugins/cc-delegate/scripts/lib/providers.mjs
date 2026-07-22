export const PROVIDERS = {
  openrouter: {
    name: "openrouter",
    envKey: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/chat/completions",
  },
  siliconflow: {
    name: "siliconflow",
    envKey: "SILICONFLOW_API_KEY",
    url: "https://api.siliconflow.com/v1/chat/completions",
  },
  deepinfra: {
    name: "deepinfra",
    envKey: "DEEPINFRA_API_KEY",
    url: "https://api.deepinfra.com/v1/openai/chat/completions",
  },
  cerebras: {
    name: "cerebras",
    envKey: "CEREBRAS_API_KEY",
    url: "https://api.cerebras.ai/v1/chat/completions",
  },
};

function toErrorMessage(error) {
  if (!error) {
    return "unknown provider error";
  }
  if (error.name === "AbortError") {
    return "request timed out after 10 minutes";
  }
  return error.message || String(error);
}

export async function callProvider(providerName, modelId, messages, opts = {}) {
  const provider = PROVIDERS[providerName];
  if (!provider) {
    throw new Error(`unknown provider ${providerName}`);
  }

  const apiKey = process.env[provider.envKey];
  if (!apiKey) {
    throw new Error(`missing API key ${provider.envKey}`);
  }

  // Per-model override (registry timeoutMs) for slow reasoners like Kimi K3.
  const timeoutMs = Number(opts.timeoutMs) || 10 * 60 * 1000;
  // ponytail: hard-cap provider calls at 10 minutes to avoid orphaned workers.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(provider.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        max_tokens: opts.maxTokens,
        stream: false,
      }),
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : {};

    if (!response.ok) {
      const snippet = text.slice(0, 400).replace(/\s+/g, " ").trim();
      throw new Error(`HTTP ${response.status} from ${providerName}: ${snippet}`);
    }

    return data;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`invalid JSON from ${providerName}`);
    }
    throw new Error(toErrorMessage(error));
  } finally {
    clearTimeout(timeout);
  }
}
