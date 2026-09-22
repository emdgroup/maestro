/**
 * What the popover over a focused slot says.
 *
 * Examples for that field rather than generic cron syntax: `9-17` is worth reading as "09:00
 * through 17:00" on the hour slot and as nothing at all on the month slot, so each field carries
 * its own six.
 */

import type { FieldKind } from "./fields";

export interface FieldDoc {
  title: string;
  range: string;
  examples: Array<{ token: string; meaning: string }>;
  /** One line about the thing this field does that surprises people. */
  caution?: string;
}

export const FIELD_DOCS: Record<FieldKind, FieldDoc> = {
  minute: {
    title: "Minute",
    range: "0 to 59",
    examples: [
      { token: "*", meaning: "every minute" },
      { token: "0", meaning: "on the hour" },
      { token: "*/30", meaning: "every 30 minutes" },
      { token: "0,30", meaning: "at 0 and 30 past" },
      { token: "15-45", meaning: "every minute from 15 to 45 past" },
      { token: "0-30/10", meaning: "at 0, 10, 20 and 30 past" },
    ],
    caution: "A step restarts each hour, so only values that divide 60 stay evenly spaced.",
  },
  hour: {
    title: "Hour",
    range: "0 to 23",
    examples: [
      { token: "*", meaning: "every hour" },
      { token: "9", meaning: "the 09:00 hour" },
      { token: "9-17", meaning: "09:00 through 17:00" },
      { token: "9,13,17", meaning: "those three hours" },
      { token: "*/4", meaning: "every 4th hour from midnight" },
      { token: "9-17/2", meaning: "every 2nd hour in that range" },
    ],
  },
  dayOfMonth: {
    title: "Day of month",
    range: "1 to 31",
    examples: [
      { token: "*", meaning: "every day" },
      { token: "1", meaning: "the 1st" },
      { token: "1,15", meaning: "the 1st and the 15th" },
      { token: "1-7", meaning: "the first week" },
      { token: "*/2", meaning: "every other day" },
      { token: "28", meaning: "the last day every month has" },
    ],
    caution: "Anything above 28 skips the months that are shorter than it.",
  },
  month: {
    title: "Month",
    range: "1 to 12, or names such as Jan",
    examples: [
      { token: "*", meaning: "every month" },
      { token: "1", meaning: "January" },
      { token: "1,7", meaning: "January and July" },
      { token: "6-8", meaning: "June through August" },
      { token: "*/3", meaning: "every 3rd month" },
      { token: "Jan", meaning: "January, written as a name" },
    ],
  },
  dayOfWeek: {
    title: "Day of week",
    range: "0 to 7, where both 0 and 7 are Sunday",
    examples: [
      { token: "*", meaning: "every day" },
      { token: "1", meaning: "Mondays" },
      { token: "1-5", meaning: "Monday through Friday" },
      { token: "6,0", meaning: "Saturdays and Sundays" },
      { token: "Mon", meaning: "Mondays, written as a name" },
      { token: "1-5/2", meaning: "Monday, Wednesday and Friday" },
    ],
    caution: "Set this and day of month together and cron fires on either, not on both at once.",
  },
};
