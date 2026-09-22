/**
 * The menu the sentence opens.
 *
 * One entry per cron mechanism, never one per number: every 2 hours and every 6 hours are the
 * same expression with a different digit, so the list carries one and the hour slot carries the
 * rest. Between them these ten use every form the fields have, which is the point. Picking one is
 * how somebody who does not write cron gets a working schedule and something to edit.
 *
 * **Expressions only.** A hand-written label reads better than a generated one right up until it
 * disagrees with it, and then the menu promises one schedule and the sentence above the slots
 * describes another. Both are built by `describeExpression`, so what you pick is what you read.
 */

export const SCHEDULE_TEMPLATES: string[] = [
  "*/15 * * * *",
  "0 */2 * * *",
  "0 9 * * *",
  "0 9,17 * * *",
  "0 9 * * 1-5",
  "0 8 * * 1",
  "0 10 * * 6,0",
  "*/30 9-17 * * 1-5",
  "0 7 1 * *",
  "0 7 1 */3 *",
];

/** What a schedule starts as when the toggle is turned on and there is nothing stored yet. */
export const DEFAULT_CRON = "0 9 * * *";
