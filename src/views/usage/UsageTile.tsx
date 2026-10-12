import { useState } from "react";
import { useUsageReport } from "@/services/usage.service";
import { formatCost, formatTokens } from "./format";
import { resolveRange } from "./range";

/** Home's way into the Usage view: the last 7 days, from the mirror. Nothing until a sync. */
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
    <button
      type="button"
      onClick={onOpen}
      className="home-pane cursor-pointer self-end rounded-2xl px-4 py-2.5 text-left"
    >
      <div className="text-[11px] text-muted-foreground">This week</div>
      <div className="text-sm font-semibold tabular-nums">
        {formatCost(data.cost)} · {formatTokens(data.tokens)} tokens{" "}
        <span className="text-muted-foreground">›</span>
      </div>
    </button>
  );
}
