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

// ANSI-aware clip to at most `width` visible columns, truncating with "…"
// when needed. Escape sequences are copied through without consuming width
// budget, so pre-colored table rows stay intact instead of getting cut mid
// escape code. Used to guarantee a rendered line can never wrap a terminal.
export function clipVisible(text, width) {
  const str = String(text);
  if (width <= 0) {
    return "";
  }
  if (visibleLength(str) <= width) {
    return str;
  }

  const hasAnsi = /\x1b\[[0-9;]*m/.test(str);
  const re = /\x1b\[[0-9;]*m/g;
  const budget = Math.max(0, width - 1);

  let result = "";
  let visibleCount = 0;
  let i = 0;
  while (i < str.length && visibleCount < budget) {
    re.lastIndex = i;
    const match = re.exec(str);
    if (match && match.index === i) {
      result += match[0];
      i += match[0].length;
      continue;
    }
    result += str[i];
    visibleCount += 1;
    i += 1;
  }
  return hasAnsi ? `${result}…\x1b[0m` : `${result}…`;
}
