// Editorial, not computable: why each provider is/isn't worth a key.
export const VERDICTS = {
  openrouter: "covers all 5 models, best price for most — recommended first key",
  siliconflow: "optional: mainly valuable as kimi fallback",
  deepinfra: "optional fallback",
  cerebras: "qwen only, ultra-fast inference",
};

const PROVIDER_ORDER = ["openrouter", "siliconflow", "deepinfra", "cerebras"];

function formatPrice(value) {
  const num = Number(value || 0);
  const rounded = Math.round(num * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

export function renderProviderGuide(models) {
  const byProvider = {};

  for (const [alias, model] of Object.entries(models)) {
    model.providers.forEach((provider, index) => {
      const list = byProvider[provider.name] || (byProvider[provider.name] = []);
      const pricing = provider.pricing || model.pricing || {};
      const suffix = index === 0 ? "" : " (fallback)";
      list.push(`${alias} $${formatPrice(pricing.input)}/$${formatPrice(pricing.output)}${suffix}`);
    });
  }

  const names = PROVIDER_ORDER.filter((name) => byProvider[name]);
  const nameWidth = Math.max(...names.map((name) => name.length));
  const lines = ["Provider guide (from models.json)"];

  for (const name of names) {
    lines.push(`  ${name.padEnd(nameWidth)}  ${byProvider[name].join(" · ")}`);
    lines.push(`  ${" ".repeat(nameWidth)}  → ${VERDICTS[name] || "no verdict on file"}`);
  }

  return lines.join("\n");
}
