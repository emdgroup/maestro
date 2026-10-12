import { addDays, addWeeks, format as formatDate, startOfDay, startOfWeek } from "date-fns";
import type { UsageDayCell, UsageHeatCell } from "@/types/bindings";
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
const shade = (v: number, max: number) =>
  `color-mix(in oklab, var(--usage-1) ${6 + (94 * v) / max}%, transparent)`;

function Legend() {
  return (
    <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span>less</span>
      <span
        className="h-2 w-24 rounded"
        style={{ background: `linear-gradient(90deg, ${shade(0, 1)}, var(--usage-1))` }}
      />
      <span>more</span>
    </div>
  );
}

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
                    style={{ background: shade(v, max) }}
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
      <Legend />
    </div>
  );
}

interface UsageCalendarProps {
  days: UsageDayCell[];
  start: Date;
  /** Exclusive. */
  end: Date;
  metric: Metric;
  format: (value: number) => string;
}

/** The selected metric per day, one column per week from Monday, on the heatmap's hue. */
export function UsageCalendar({ days, start, end, metric, format }: UsageCalendarProps) {
  const values = new Map(days.map((d) => [d.day, metric === "cost" ? d.cost : d.tokens]));
  const max = Math.max(...values.values(), 0) || 1;
  const first = startOfDay(start);
  const weeks: Date[] = [];
  for (let week = startOfWeek(first, { weekStartsOn: 1 }); week < end; week = addWeeks(week, 1)) {
    weeks.push(week);
  }
  const columns = { gridTemplateColumns: `repeat(${weeks.length}, minmax(10px, 1fr))` };
  return (
    <div className="overflow-x-auto">
      <div style={{ maxWidth: `calc(2.25rem + ${weeks.length * 40}px)` }}>
        <div className="grid grid-cols-[2.25rem_1fr]">
          <span />
          <div className="grid gap-[3px] text-[11px] text-muted-foreground" style={columns}>
            {weeks.map((week, i) => {
              // A month is labelled on the week holding its first day, and on the first week.
              const firstOfMonth = Array.from({ length: 7 }, (_, d) => addDays(week, d)).find(
                (day) => day.getDate() === 1 && day >= first && day < end,
              );
              const label = firstOfMonth ?? (i === 0 ? first : null);
              return (
                <span key={week.toISOString()} className="h-4 overflow-visible whitespace-nowrap">
                  {label && formatDate(label, "MMM")}
                </span>
              );
            })}
          </div>
        </div>
        <div className="grid grid-cols-[2.25rem_1fr] gap-y-1">
          {DAYS.map(([weekday, name]) => (
            <div key={name} className="contents">
              <span className="text-[11px] leading-[18px] text-muted-foreground">{name}</span>
              <div className="grid gap-[3px]" style={columns}>
                {weeks.map((week) => {
                  const day = addDays(week, (weekday + 6) % 7);
                  if (day < first || day >= end) return <span key={week.toISOString()} />;
                  const v = values.get(formatDate(day, "yyyy-MM-dd")) ?? 0;
                  return (
                    <div
                      key={week.toISOString()}
                      title={`${formatDate(day, "EEE, MMM d")} · ${format(v)}`}
                      className="h-[18px] rounded"
                      style={{ background: shade(v, max) }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <Legend />
    </div>
  );
}
