// Shared TTY-aware color/emphasis helpers. No-ops when the target stream
// isn't a TTY so piped/non-interactive output stays free of ANSI codes.
export function terminalStyles(stream) {
  if (!stream || !stream.isTTY) {
    return {
      dim: (text) => text,
      bold: (text) => text,
      cyan: (text) => text,
      red: (text) => text,
      yellow: (text) => text,
      green: (text) => text,
    };
  }
  return {
    dim: (text) => `\x1b[2m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[0m`,
    cyan: (text) => `\x1b[36m${text}\x1b[0m`,
    red: (text) => `\x1b[31m${text}\x1b[0m`,
    yellow: (text) => `\x1b[33m${text}\x1b[0m`,
    green: (text) => `\x1b[32m${text}\x1b[0m`,
  };
}

// The cyan "▎" + bold label used to mark section titles across usage views.
export function sectionTitle(title, styles) {
  return `${styles.cyan("▎")}${styles.bold(title)}`;
}
