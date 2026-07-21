const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Length ignoring ANSI color codes — used only where color is applied before
// a width computation (e.g. word-wrapping already-colored tokens).
export function visibleLength(text) {
  return String(text).replace(ANSI_RE, "").length;
}

// padEnd that ignores embedded ANSI color codes when measuring width, so
// already-colored text still aligns into columns.
export function padVisible(text, width) {
  const str = String(text);
  const len = visibleLength(str);
  return len >= width ? str : str + " ".repeat(width - len);
}
