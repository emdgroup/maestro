import { useState } from "react";
import { useUsageReport } from "@/services/usage.service";
import { formatCost } from "./format";
import { bucketKeys, resolveRange } from "./range";

const BAR = 9;
const GAP = 3;
const HEIGHT = 26;

/**
 * Home's way into the Usage view, ahead of the three counts and quieter than them: the last 7
 * days' cost as a sparkline of one bar a day, from the mirror. Nothing until a sync.
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
  const days = bucketKeys(range, undefined).map((day) =>
    data.series.filter((p) => p.bucket === day).reduce((sum, p) => sum + (p.cost ?? 0), 0),
  );
  const max = Math.max(...days, 0) || 1;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Usage: ${formatCost(data.cost)} this week`}
      className="group mb-1 cursor-pointer self-end text-left"
    >
      <svg
        width={days.length * (BAR + GAP) - GAP}
        height={HEIGHT}
        className="text-accent opacity-70 transition-opacity group-hover:opacity-100"
        aria-hidden
      >
        {days.map((value, i) => {
          // An empty day keeps a sliver, so the week still reads as seven days.
          const height = Math.max((value / max) * HEIGHT, 2);
          return (
            <rect
              key={i}
              x={i * (BAR + GAP)}
              y={HEIGHT - height}
              width={BAR}
              height={height}
              rx={2}
              fill="currentColor"
            />
          );
        })}
      </svg>
      <div className="mt-1 text-xs text-muted-foreground tabular-nums group-hover:text-foreground">
        {formatCost(data.cost)} this week ›
      </div>
    </button>
  );
}
