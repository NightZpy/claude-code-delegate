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

// Parses an OpenAI-compatible SSE chat-completion stream (no deps) into the
// same shape callers expect from a non-streaming response. `reasoning_content`
// (thinking, emitted by reasoner models on SiliconFlow) is tracked separately
// and never folded into `content` — it's chain-of-thought, not the answer.
async function readSseStream(response, providerName) {
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  let usage = null;
  let model = null;
  let id = null;
  let finishReason = null;

  const processLine = (line) => {
    if (!line.startsWith("data:")) {
      return;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      return;
    }
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return; // ponytail: skip a malformed SSE line rather than abort the whole stream
    }
    id = id || event.id || null;
    model = model || event.model || null;
    if (event.usage) {
      usage = event.usage;
    }
    const choice = event.choices?.[0];
    if (choice?.delta?.content) {
      content += choice.delta.content;
    }
    if (choice?.delta?.reasoning_content) {
      reasoningContent += choice.delta.reasoning_content;
    }
    if (choice?.finish_reason) {
      finishReason = choice.finish_reason;
    }
  };

  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        processLine(buffer.slice(0, newlineIndex).trim());
        buffer = buffer.slice(newlineIndex + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      processLine(buffer.trim());
    }
  } catch (error) {
    throw new Error(
      `stream from ${providerName} ended prematurely after ${content.length} chars: ${toErrorMessage(error)}`,
    );
  }

  return {
    id,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason,
      },
    ],
    usage,
    reasoningLength: reasoningContent.length,
  };
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
  // Now covers the whole SSE stream (fetch through [DONE]), not just headers.
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
        stream: true,
        stream_options: { include_usage: true },
        ...opts.requestParams,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      const snippet = text.slice(0, 400).replace(/\s+/g, " ").trim();
      throw new Error(`HTTP ${response.status} from ${providerName}: ${snippet}`);
    }

    // SiliconFlow's edge hangs/504s on long non-streamed outputs (reproduced
    // on deepseek/kimi); streaming and accumulating avoids that entirely.
    return await readSseStream(response, providerName);
  } catch (error) {
    throw new Error(toErrorMessage(error));
  } finally {
    clearTimeout(timeout);
  }
}
