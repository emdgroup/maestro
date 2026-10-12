import { useState } from "react";
import { ChartColumn } from "lucide-react";
import { useUsageReport } from "@/services/usage.service";
import { formatCost, formatTokens } from "./format";
import { resolveRange } from "./range";

/**
 * Home's way into the Usage view, a score of its own ahead of the three: the last 7 days' cost,
 * from the mirror. Nothing until a sync.
 */
export function UsageTile({ onOpen }: { onOpen: () => void }) {
  const [range] = useState(() => resolveRange({ preset: "7d" }, new Date()));
  const { data } = useUsageReport({
    start: range.start?.toISOString() ?? null,
    end: range.end.toISOString(),
    bucket: range.bucket,
    split: "connection",
    projects: [],
    models: [],
  });
  if (!data?.coverage.length) return null;
  return (
    <>
      <button type="button" onClick={onOpen} className="group cursor-pointer text-left">
        <div className="text-[52px] leading-none font-semibold tracking-[-0.025em] tabular-nums">
          {formatCost(data.cost)}
        </div>
        <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground">
          <ChartColumn className="size-3" />
          this week · {formatTokens(data.tokens)} tokens ›
        </div>
      </button>
      <span aria-hidden className="w-px self-stretch bg-foreground/10" />
    </>
  );
}
