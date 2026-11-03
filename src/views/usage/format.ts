import { formatCost, formatTokens } from "@/lib/format-utils";

export type Metric = "cost" | "tokens";

/** The usage view assumes one currency, as the design does. */
export const formatMetric = (metric: Metric) =>
  metric === "cost" ? (value: number) => formatCost(value) : formatTokens;
