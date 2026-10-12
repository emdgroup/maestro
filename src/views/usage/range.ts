import {
  addDays,
  addHours,
  addMinutes,
  addMonths,
  differenceInCalendarDays,
  format,
  startOfDay,
  startOfHour,
  startOfMinute,
  startOfMonth,
  subDays,
  subHours,
  subMinutes,
  subMonths,
} from "date-fns";
import type { UsageBucket } from "@/types/bindings";

export type Preset = "1h" | "1d" | "7d" | "30d" | "12m" | "all";

export const PRESETS: { id: Preset; label: string }[] = [
  { id: "1h", label: "Last hour" },
  { id: "1d", label: "Last 24 hours" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "12m", label: "Last 12 months" },
  { id: "all", label: "All time" },
];

/** What the user picked: a preset, or two days of the calendar. */
export type RangeChoice = { preset: Preset } | { from: Date; to: Date };

export interface UsageRange {
  /** `null` for the first record. */
  start: Date | null;
  /** Exclusive. */
  end: Date;
  bucket: UsageBucket;
}

/** A custom range is cut by how long it is: up to 3 days by hour, up to 90 by day, else by month. */
function bucketForDays(days: number): UsageBucket {
  if (days <= 3) return "hour";
  if (days <= 90) return "day";
  return "month";
}

export function resolveRange(choice: RangeChoice, now: Date): UsageRange {
  if ("from" in choice) {
    const start = startOfDay(choice.from);
    const end = addDays(startOfDay(choice.to), 1);
    return { start, end, bucket: bucketForDays(differenceInCalendarDays(end, start)) };
  }
  switch (choice.preset) {
    case "1h":
      return { start: subMinutes(startOfMinute(now), 59), end: now, bucket: "minute" };
    case "1d":
      return { start: subHours(startOfHour(now), 23), end: now, bucket: "hour" };
    case "7d":
      return { start: subDays(startOfDay(now), 6), end: now, bucket: "day" };
    case "30d":
      return { start: subDays(startOfDay(now), 29), end: now, bucket: "day" };
    case "12m":
      return { start: subMonths(startOfMonth(now), 11), end: now, bucket: "month" };
    case "all":
      return { start: null, end: now, bucket: "month" };
  }
}

/**
 * The heatmap needs a week of data to say anything. A week is hours by weekday; anything longer
 * is a calendar of days, since a week of days would be one column.
 */
export function heatmapKind(choice: RangeChoice): "hours" | "days" | null {
  if ("from" in choice) {
    const days = differenceInCalendarDays(choice.to, choice.from) + 1;
    return days < 7 ? null : days === 7 ? "hours" : "days";
  }
  if (choice.preset === "1h" || choice.preset === "1d") return null;
  return choice.preset === "7d" ? "hours" : "days";
}

/** The title's words: `Usage over the last 7 days`. */
export function rangeTitle(choice: RangeChoice): string {
  if ("from" in choice) return "custom range";
  return PRESETS.find((p) => p.id === choice.preset)!.label.toLowerCase();
}

const KEY_FORMAT: Record<UsageBucket, string> = {
  minute: "yyyy-MM-dd'T'HH:mm",
  hour: "yyyy-MM-dd'T'HH",
  day: "yyyy-MM-dd",
  month: "yyyy-MM",
};

const STEP: Record<UsageBucket, (date: Date, n: number) => Date> = {
  minute: addMinutes,
  hour: addHours,
  day: addDays,
  month: addMonths,
};

const FLOOR: Record<UsageBucket, (date: Date) => Date> = {
  minute: startOfMinute,
  hour: startOfHour,
  day: startOfDay,
  month: startOfMonth,
};

/** A bucket's key as the report names it, in the local clock. */
export function bucketKey(date: Date, bucket: UsageBucket): string {
  return format(date, KEY_FORMAT[bucket]);
}

export function parseKey(key: string, bucket: UsageBucket): Date {
  const [day, time] = key.split("T");
  const [y, m, d] = day.split("-").map(Number);
  const [h, min] = (time ?? "").split(":").map(Number);
  return bucket === "month" ? new Date(y, m - 1, 1) : new Date(y, m - 1, d ?? 1, h || 0, min || 0);
}

/**
 * Every bucket of the range, empty ones included, so the chart has one slot each. With no start
 * (All time) it begins at the earliest bucket the report has, or the current one.
 */
export function bucketKeys(range: UsageRange, earliest: string | undefined): string[] {
  const first =
    range.start ?? (earliest ? parseKey(earliest, range.bucket) : FLOOR[range.bucket](range.end));
  const keys: string[] = [];
  for (let at = FLOOR[range.bucket](first); at < range.end; at = STEP[range.bucket](at, 1)) {
    keys.push(bucketKey(at, range.bucket));
  }
  return keys;
}

/** A short axis label for a bucket. */
export function bucketLabel(key: string, bucket: UsageBucket): string {
  const date = parseKey(key, bucket);
  if (bucket === "minute") return format(date, "HH:mm");
  if (bucket === "hour") return format(date, "HH:00");
  if (bucket === "day") return format(date, "MMM d");
  return format(date, "MMM yyyy");
}

/** The dates under the title: `Oct 5 – Oct 11, 2026`, with times for the short ranges. */
export function describeDates(range: UsageRange, earliest: string | undefined): string {
  const start =
    range.start ?? (earliest ? parseKey(earliest, range.bucket) : startOfMonth(range.end));
  if (range.bucket === "minute" || range.bucket === "hour") {
    return `${format(start, "MMM d, HH:mm")} – ${format(range.end, "MMM d, HH:mm")}`;
  }
  // The end is exclusive: a range ending at midnight ends the day before.
  const last =
    range.end.getTime() === startOfDay(range.end).getTime() ? subDays(range.end, 1) : range.end;
  if (range.bucket === "month") return `${format(start, "MMM yyyy")} – ${format(last, "MMM yyyy")}`;
  return `${format(start, "MMM d")} – ${format(last, "MMM d, yyyy")}`;
}
