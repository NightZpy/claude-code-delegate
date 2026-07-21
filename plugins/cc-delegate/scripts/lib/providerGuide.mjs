import { visibleLength } from "./ansi.mjs";

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

// Greedy word-wrap that keeps each "alias $in/$out" pair intact — a pair is
// never split across lines, even on a narrow terminal.
function wrapPairs(pairs, columns, indent) {
  const maxWidth = Math.max(20, columns);
  const lines = [];
  let current = indent;

  for (const pair of pairs) {
    const pieceLen = visibleLength(pair);
    const atLineStart = current === indent;
    const sep = atLineStart ? "" : "   ";
    const candidateLen = visibleLength(current) + sep.length + pieceLen;
    if (!atLineStart && candidateLen > maxWidth) {
      lines.push(current);
      current = indent + pair;
    } else {
      current += sep + pair;
    }
  }
  lines.push(current);
  return lines;
}

export function renderProviderGuide(models, styles, columns = 100) {
  const byProvider = {};

  for (const [alias, model] of Object.entries(models)) {
    model.providers.forEach((provider, index) => {
      const list = byProvider[provider.name] || (byProvider[provider.name] = []);
      const pricing = provider.pricing || model.pricing || {};
      const text = `${alias} $${formatPrice(pricing.input)}/$${formatPrice(pricing.output)}`;
      list.push(index === 0 ? text : `${text} ${styles.dim("(fallback)")}`);
    });
  }

  const names = PROVIDER_ORDER.filter((name) => byProvider[name]);
  const nameWidth = Math.max(...names.map((name) => name.length));
  const lines = ["Provider guide (from models.json)", ""];

  for (const name of names) {
    lines.push(
      `${styles.cyan("▎")}${styles.bold(name.padEnd(nameWidth))}  → ${styles.dim(VERDICTS[name] || "no verdict on file")}`,
    );
    lines.push(...wrapPairs(byProvider[name], columns, "  "));
  }

  return lines.join("\n");
}
