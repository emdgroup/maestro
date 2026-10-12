import type { UsageHeatCell } from "@/types/bindings";
import type { Metric } from "./format";

/** Monday first; the report counts weekdays from Sunday, as SQLite does. */
const DAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [0, "Sun"],
] as const;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const pad = (hour: number) => String(hour).padStart(2, "0");

interface UsageHeatmapProps {
  cells: UsageHeatCell[];
  metric: Metric;
  format: (value: number) => string;
}

/** The selected metric summed per hour of each weekday over the range, on one hue. */
export function UsageHeatmap({ cells, metric, format }: UsageHeatmapProps) {
  const value = (weekday: number, hour: number) => {
    const cell = cells.find((c) => c.weekday === weekday && c.hour === hour);
    return cell ? (metric === "cost" ? cell.cost : cell.tokens) : 0;
  };
  const max = Math.max(...cells.map((c) => (metric === "cost" ? c.cost : c.tokens)), 0) || 1;
  return (
    <div>
      <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
        {DAYS.map(([weekday, name]) => (
          <div key={name} className="contents">
            <span className="text-[11px] leading-[18px] text-muted-foreground">{name}</span>
            <div className="grid grid-cols-24 gap-[3px]">
              {HOURS.map((hour) => {
                const v = value(weekday, hour);
                return (
                  <div
                    key={hour}
                    title={`${name} ${pad(hour)}:00–${pad(hour + 1)}:00 · ${format(v)}`}
                    className="h-[18px] rounded"
                    style={{ background: `rgb(var(--usage-seq) / ${0.06 + (0.94 * v) / max})` }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 ml-9 flex justify-between text-[11px] text-muted-foreground">
        {[0, 3, 6, 9, 12, 15, 18, 21].map((hour) => (
          <span key={hour}>{pad(hour)}:00</span>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span>less</span>
        <span
          className="h-2 w-24 rounded"
          style={{
            background:
              "linear-gradient(90deg, rgb(var(--usage-seq) / 0.06), rgb(var(--usage-seq)))",
          }}
        />
        <span>more</span>
      </div>
    </div>
  );
}
