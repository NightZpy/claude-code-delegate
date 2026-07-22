import { visibleLength, padVisible, clipVisible } from "./ansi.mjs";
import { sectionTitle } from "./styles.mjs";

// Editorial, not computable: why each provider is/isn't worth a key.
export const VERDICTS = {
  openrouter: "covers every model, best price for most — recommended first key",
  siliconflow: "optional: mainly valuable as kimi fallback",
  deepinfra: "optional fallback",
  cerebras: "qwen only, ultra-fast inference",
};

const PROVIDER_ORDER = ["openrouter", "siliconflow", "deepinfra", "cerebras"];

// Editorial ordering: cheap/bulk models first, frontier/expensive last.
const MODEL_ORDER = ["qwen", "deepseek", "deepseek-pro", "glm", "kimi", "grok"];

const SEP = "  ";

// Providers actually reachable through the current model registry — a
// provider with zero routes (e.g. a removed fallback) is dropped everywhere
// in the guide instead of showing an empty column/verdict.
export function getActiveProviders(models) {
  return PROVIDER_ORDER.filter((name) =>
    Object.values(models).some((model) => model.providers.some((provider) => provider.name === name)),
  );
}

function formatPrice(value) {
  return Number(value || 0).toFixed(2);
}

// Compact context-window label: 262144 -> "262k", 1000000/1048576 -> "1M".
function formatContext(context) {
  if (context >= 1_000_000) {
    const millions = Math.round((context / 1_000_000) * 10) / 10;
    return `${millions}M`;
  }
  return `${Math.round(context / 1000)}k`;
}

// The part of a provider's model id after the vendor prefix, e.g.
// "qwen/qwen3-coder-next" -> "qwen3-coder-next"; ids with no "/" (like some
// Cerebras entries) are used whole.
function versionOf(id) {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

function priceOf(model, provider) {
  const pricing = provider.pricing || model.pricing || {};
  return `${formatPrice(pricing.input)}/${formatPrice(pricing.output)}`;
}

const FOOTNOTE_MARKS = ["¹", "²", "³", "⁴", "⁵"];

function buildProviderCell(model, providerName, styles, footnotes) {
  const provider = model.providers.find((p) => p.name === providerName);
  if (!provider) {
    return styles.dim("—");
  }

  const primary = model.providers[0];
  const isPrimary = provider === primary;
  const price = priceOf(model, provider);
  const dot = isPrimary ? `${styles.cyan("●")} ` : "";

  // A diverging variant becomes a footnote instead of an inline suffix — the
  // suffix bloated the column enough to get it dropped on ~90-col terminals.
  const variant = versionOf(provider.id);
  let suffix = "";
  if (variant.toLowerCase() !== versionOf(primary.id).toLowerCase()) {
    const note = `${providerName} serves ${variant} (different variant)`;
    let index = footnotes.indexOf(note);
    if (index === -1) {
      index = footnotes.push(note) - 1;
    }
    suffix = ` ${styles.dim(FOOTNOTE_MARKS[index] || "*")}`;
  }

  return `${dot}${price}${suffix}`;
}

// Renders the "MODEL alias + version" field, e.g. bold "qwen" + dim
// "qwen3-coder-next".
function buildModelField(alias, model, styles) {
  return `${styles.bold(alias)}  ${styles.dim(versionOf(model.providers[0].id))}`;
}

function formatQuality(quality) {
  return "★".repeat(Number(quality) || 0);
}

// Builds the "Models × providers" comparison matrix. Drops provider columns
// right-to-left until the table fits `columns`, noting how many were cut.
function renderMatrix(models, providerNames, styles, columns) {
  // Preferred order first, then any registry alias not in the list — a newly
  // added model must never silently vanish from the guide.
  const aliases = [
    ...MODEL_ORDER.filter((alias) => models[alias]),
    ...Object.keys(models).filter((alias) => !MODEL_ORDER.includes(alias)),
  ];

  const modelFields = aliases.map((alias) => buildModelField(alias, models[alias], styles));
  const qualityFields = aliases.map((alias) => formatQuality(models[alias].quality));
  const ctxFields = aliases.map((alias) => formatContext(models[alias].context));
  const footnotes = [];
  const providerFields = {};
  for (const name of providerNames) {
    providerFields[name] = aliases.map((alias) => buildProviderCell(models[alias], name, styles, footnotes));
  }

  const modelWidth = Math.max(visibleLength("MODEL"), ...modelFields.map(visibleLength));
  const qualityWidth = Math.max(visibleLength("QUALITY"), ...qualityFields.map(visibleLength));
  const ctxWidth = Math.max(visibleLength("CTX"), ...ctxFields.map(visibleLength));
  const providerWidths = {};
  for (const name of providerNames) {
    providerWidths[name] = Math.max(
      visibleLength(name.toUpperCase()),
      ...providerFields[name].map(visibleLength),
    );
  }

  // Drop provider columns from the right until the row fits `columns`.
  const shownProviders = [...providerNames];
  const fixedWidth = modelWidth + qualityWidth + ctxWidth + 2 * SEP.length;
  const widthOf = (names) =>
    fixedWidth + names.reduce((sum, name) => sum + providerWidths[name] + SEP.length, 0);
  while (shownProviders.length > 0 && widthOf(shownProviders) > columns) {
    shownProviders.pop();
  }
  const droppedCount = providerNames.length - shownProviders.length;

  const headerCells = [
    padVisible("MODEL", modelWidth),
    padVisible("QUALITY", qualityWidth),
    padVisible("CTX", ctxWidth),
    ...shownProviders.map((name) => padVisible(name.toUpperCase(), providerWidths[name])),
  ];
  const lines = [
    sectionTitle("Models × providers ($ per 1M tokens, in/out · ● = primary route)", styles),
    "",
    styles.dim(styles.underline(headerCells.join(SEP))),
  ];

  aliases.forEach((alias, index) => {
    const cells = [
      padVisible(modelFields[index], modelWidth),
      padVisible(qualityFields[index], qualityWidth),
      padVisible(ctxFields[index], ctxWidth),
      ...shownProviders.map((name) => padVisible(providerFields[name][index], providerWidths[name])),
    ];
    lines.push(cells.join(SEP));
  });

  if (droppedCount > 0) {
    lines.push(
      styles.dim(`… ${droppedCount} more provider${droppedCount === 1 ? "" : "s"}: use a wider terminal or models --json`),
    );
  }
  footnotes.forEach((note, index) => {
    lines.push(styles.dim(`${FOOTNOTE_MARKS[index] || "*"} ${note}`));
  });

  return lines.map((line) => clipVisible(line, columns));
}

export function renderProviderGuide(models, styles, columns = 100) {
  const providerNames = getActiveProviders(models);

  const lines = [...renderMatrix(models, providerNames, styles, columns), ""];

  for (const name of providerNames) {
    lines.push(styles.dim(`▎ ${name}: ${VERDICTS[name] || "no verdict on file"}`));
  }

  lines.push("", styles.dim("Delegations are direct text-completion calls to the provider APIs."));

  return lines.join("\n");
}
