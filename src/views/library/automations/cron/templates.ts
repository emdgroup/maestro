/**
 * The menu the sentence opens.
 *
 * One entry per cron mechanism, never one per number: every 2 hours and every 6 hours are the
 * same expression with a different digit, so the list carries one and the hour slot carries the
 * rest. Between them these ten use every form the fields have, which is the point. Picking one is
 * how somebody who does not write cron gets a working schedule and something to edit.
 *
 * The sentence here is the template's own rather than one built from its expression: a menu entry
 * can be phrased for a reader, where a generated sentence has to be phrased for every expression.
 */

export interface ScheduleTemplate {
  /** What the menu shows. */
  label: string;
  cron: string;
}

export const SCHEDULE_TEMPLATES: ScheduleTemplate[] = [
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every 2 hours", cron: "0 */2 * * *" },
  { label: "Every day at 09:00", cron: "0 9 * * *" },
  { label: "Twice a day, at 09:00 and 17:00", cron: "0 9,17 * * *" },
  { label: "Monday through Friday at 09:00", cron: "0 9 * * 1-5" },
  { label: "Every Monday at 08:00", cron: "0 8 * * 1" },
  { label: "Weekends at 10:00", cron: "0 10 * * 6,0" },
  { label: "Every 30 minutes, 09:00 to 17:30, weekdays", cron: "*/30 9-17 * * 1-5" },
  { label: "On the 1st of every month at 07:00", cron: "0 7 1 * *" },
  { label: "Every three months, on the 1st at 07:00", cron: "0 7 1 */3 *" },
];

/** What a schedule starts as when the toggle is turned on and there is nothing stored yet. */
export const DEFAULT_CRON = "0 9 * * *";
