export type Metric = "cost" | "tokens";

/** `$142.18`, and whole dollars from a thousand up. Assumes one currency, as the design does. */
export function formatCost(value: number): string {
  return value >= 1000 ? `$${Math.round(value).toLocaleString("en-US")}` : `$${value.toFixed(2)}`;
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** `268M`, `1.6M`, `106.9K`. */
export function formatTokens(value: number): string {
  return compact.format(value);
}

export const formatMetric = (metric: Metric) => (metric === "cost" ? formatCost : formatTokens);

/** The folder's name, in either separator. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
