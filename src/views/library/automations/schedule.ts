/**
 * Between the three presets the editor offers and the cron the server stores.
 *
 * Cron is what the background server evaluates, because it is what keeps running when this window
 * is closed. Nothing here works out when an automation is next due: the server returns that with
 * the automation, so the two can never disagree about a schedule only one of them acts on.
 */

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export type ScheduleKind = "Manual" | "Daily" | "Weekdays" | "Weekly";

export interface SchedulePreset {
  kind: ScheduleKind;
  /** `HH:MM`. */
  time: string;
  /** 0 is Sunday through 6 is Saturday, as in cron. Only read for `Weekly`. */
  weekday: number;
}

export const MANUAL: SchedulePreset = { kind: "Manual", time: "09:00", weekday: 1 };

/** The zone the server will read this automation's schedule in: the one the user is sitting in. */
export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The cron for a preset, or null for "manual only", which is the absence of a schedule. */
export function toCron(preset: SchedulePreset): string | null {
  const [hours, minutes] = preset.time.split(":");
  const hour = Number(hours);
  const minute = Number(minutes);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  const at = `${minute} ${hour} * * `;
  if (preset.kind === "Daily") return `${at}*`;
  if (preset.kind === "Weekdays") return `${at}1-5`;
  if (preset.kind === "Weekly") return `${at}${preset.weekday}`;
  return null;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * The preset a cron came from, or null when it came from nowhere the editor can show.
 *
 * Hand-written expressions are the reason this can fail: the store accepts any valid cron, and a
 * `*\/15 * * * 1,3` is a schedule the three presets cannot express. The editor shows those as they
 * are rather than flattening them into the nearest preset, which would silently change when it runs.
 */
export function fromCron(cron: string | null | undefined): SchedulePreset | null {
  if (!cron) return MANUAL;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, weekday] = fields;
  if (dayOfMonth !== "*" || month !== "*") return null;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;

  const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
  if (weekday === "*") return { kind: "Daily", time, weekday: 1 };
  if (weekday === "1-5") return { kind: "Weekdays", time, weekday: 1 };
  if (/^[0-6]$/.test(weekday)) return { kind: "Weekly", time, weekday: Number(weekday) };
  return null;
}

/** "Daily at 09:00", for the row and for the editor's summary. */
export function describeSchedule(cron: string | null | undefined): string {
  if (!cron) return "Manual only";
  const preset = fromCron(cron);
  if (!preset) return cron;
  if (preset.kind === "Daily") return `Daily at ${preset.time}`;
  if (preset.kind === "Weekdays") return `Weekdays at ${preset.time}`;
  if (preset.kind === "Weekly") return `${WEEKDAY_NAMES[preset.weekday]}s at ${preset.time}`;
  return "Manual only";
}

/** "today at 09:00", "tomorrow at 09:00", "Monday at 09:00". */
export function describeNextRun(next: Date, now: Date): string {
  const time = next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const days = Math.round(
    (new Date(next).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `${WEEKDAY_NAMES[next.getDay()]} at ${time}`;
}
