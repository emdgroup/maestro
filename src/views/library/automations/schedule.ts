/**
 * The two things about a schedule that are needed outside the editor.
 *
 * Everything else about reading a cron expression lives in `cron/`, and the row uses the same
 * sentence builder the editor does: a row that fell back to raw cron whenever the schedule was
 * unusual would be describing it a second way.
 */

import { describeExpression } from "./cron/describe";

/** The zone a schedule is read in by default: the one the user is sitting in. */
export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** What the row says under an automation's name. */
export function describeSchedule(cron: string | null | undefined): string {
  if (!cron) return "Manual only";
  const reading = describeExpression(cron);
  // An expression that cannot be read is shown as it is. It was stored by an older build or
  // written by hand, and rewriting it into something readable would change when it fires.
  return "error" in reading ? cron : reading.text;
}

/** "today at 09:00", "tomorrow at 09:00", "Monday at 09:00". */
export function describeNextRun(next: Date, now: Date): string {
  const time = next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const days = Math.round(
    (new Date(next).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) return `${next.toLocaleDateString([], { weekday: "long" })} at ${time}`;
  return `${next.toLocaleDateString([], { day: "numeric", month: "short" })} at ${time}`;
}
