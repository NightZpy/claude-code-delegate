export function formatUsd2(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

export function currentMonthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Spend quotas are monthly-USD-per-provider; entries with no matching provider or
// outside the current calendar month don't count toward the quota.
export function computeQuotaStatus(provider, monthlyUsd, entries) {
  const quota = Number(monthlyUsd);
  if (!Number.isFinite(quota) || quota <= 0) {
    return null;
  }
  const monthKey = currentMonthKey();
  const spent = entries.reduce((sum, entry) => {
    if (entry.provider !== provider || currentMonthKey(new Date(entry.ts)) !== monthKey) {
      return sum;
    }
    return sum + Number(entry.cost || 0);
  }, 0);
  const spentThisMonth = Number(spent.toFixed(6));
  const pct = (spentThisMonth / quota) * 100;
  const level = pct >= 100 ? "critical" : pct >= 80 ? "warning" : "ok";
  return { monthlyUsd: quota, spentThisMonth, pct, level };
}

// Non-blocking: the alert is informational text only, never a reason to fail/retry the request.
export function formatQuotaAlertLine(provider, status) {
  const icon = status.level === "critical" ? "🔴" : "⚠";
  const verb = status.level === "critical" ? "exceeded" : "at";
  return `${icon} frontier quota alert: ${provider} ${verb} ${Math.round(status.pct)}% of ${formatUsd2(status.monthlyUsd)} monthly quota (${formatUsd2(status.spentThisMonth)} spent)`;
}

export function formatQuotaBarRow(provider, status, styles, nameWidth) {
  const ratio = Math.min(1, status.spentThisMonth / status.monthlyUsd);
  const barWidth = Math.max(0, Math.round(ratio * 20));
  const color = status.level === "critical" ? styles.red : status.level === "warning" ? styles.yellow : styles.cyan;
  const bar = color("█".repeat(barWidth).padEnd(20));
  const icon = status.level === "critical" ? "🔴" : status.level === "warning" ? "⚠" : " ";
  return `  ${provider.padEnd(nameWidth)} ${bar} ${Math.round(status.pct).toString().padStart(3)}%  ${formatUsd2(status.spentThisMonth)} / ${formatUsd2(status.monthlyUsd)}  ${icon}`;
}

// Builds the "Quotas (this month)" section + any threshold alerts, independent of
// the --days/--session ledger filters (quotas always track the current calendar month).
export function buildQuotaSection(config, entries, styles) {
  const providers = Object.keys(config.quotas).sort();
  if (!providers.length) {
    return null;
  }
  const statuses = providers
    .map((provider) => [provider, computeQuotaStatus(provider, config.quotas[provider], entries)])
    .filter(([, status]) => status !== null);
  if (!statuses.length) {
    return null;
  }
  const nameWidth = Math.max(12, ...statuses.map(([provider]) => provider.length));
  const rows = statuses.map(([provider, status]) => formatQuotaBarRow(provider, status, styles, nameWidth));
  const alerts = statuses
    .filter(([, status]) => status.level !== "ok")
    .map(([provider, status]) => formatQuotaAlertLine(provider, status));
  return { rows, alerts };
}
