/**
 * An expression, in words.
 *
 * With the fields edited directly there is nothing else on screen saying what a schedule means, so
 * this is the whole of the plain language. It is built from the same parsed fields the slots are
 * coloured from, which is why it cannot drift from them.
 *
 * It describes, it does not schedule. "Every 30 minutes" is what `*\/30 * * * *` says, not a claim
 * about when the next one lands: that comes from the daemon.
 */

import {
  DAY_NAMES,
  expand,
  FIELDS,
  isError,
  MONTH_NAMES,
  parseExpression,
  type FieldValue,
} from "./fields";

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** The step of a field written as a single star with a step, or null for anything else. */
function wholeRangeStep(value: FieldValue): number | null {
  if (value.parts.length !== 1) return null;
  const [part] = value.parts;
  return part.wildcard && part.step > 1 ? part.step : null;
}

/** The one value a field names, or null when it names several. */
function only(value: FieldValue): number | null {
  const values = expand(value);
  return values.length === 1 ? values[0] : null;
}

function list(items: string[], joiner = "and"): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} ${joiner} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} ${joiner} ${items[items.length - 1]}`;
}

/** Whether a field's values are a single unbroken run, which reads as "from A to B". */
function contiguous(value: FieldValue): { from: number; to: number } | null {
  if (value.parts.length !== 1 || value.parts[0].step !== 1) return null;
  const [part] = value.parts;
  return part.from === part.to ? null : { from: part.from, to: part.to };
}

/**
 * When in the day, from the minute and hour fields together.
 *
 * The two are one clause because neither means anything alone: a minute of 30 is "half past" only
 * once the hour says how often.
 */
function timeClause(minute: FieldValue, hour: FieldValue): string {
  const minuteStep = wholeRangeStep(minute);
  const hourStep = wholeRangeStep(hour);
  const oneMinute = only(minute);
  const oneHour = only(hour);
  const hourRange = contiguous(hour);

  // Every minute of every hour, the one schedule with nothing to say about time.
  if (minute.unrestricted && hour.unrestricted) return "Every minute";
  if (minute.unrestricted && oneHour !== null) return `Every minute of the ${pad(oneHour)}:00 hour`;
  if (minute.unrestricted) return "Every minute";

  if (minuteStep !== null) {
    const every = `Every ${minuteStep} minutes`;
    if (hour.unrestricted) return every;
    if (hourRange) return `${every}, between ${pad(hourRange.from)}:00 and ${pad(hourRange.to)}:59`;
    if (oneHour !== null) return `${every}, during the ${pad(oneHour)}:00 hour`;
    return `${every}, during ${list(expand(hour).map((at) => `${pad(at)}:00`))}`;
  }

  if (hourStep !== null && oneMinute !== null) {
    const every = `Every ${hourStep === 1 ? "hour" : `${hourStep} hours`}`;
    return oneMinute === 0 ? `${every}, on the hour` : `${every}, at ${oneMinute} minutes past`;
  }

  // From here the minute field is one or more fixed values, so every hour it names is a clock time.
  const minutes = expand(minute);
  if (hour.unrestricted) {
    const past = list(minutes.map((at) => `${at}`));
    return minutes.length === 1 && minutes[0] === 0
      ? "Every hour, on the hour"
      : `Every hour, at ${past} minutes past`;
  }

  const times = expand(hour).flatMap((at) => minutes.map((minute) => `${pad(at)}:${pad(minute)}`));
  if (hourRange && minutes.length === 1) {
    return `Every hour from ${pad(hourRange.from)}:${pad(minutes[0])} to ${pad(hourRange.to)}:${pad(minutes[0])}`;
  }
  return `At ${list(times)}`;
}

function dayOfMonthClause(value: FieldValue): string | null {
  if (value.unrestricted) return null;
  const step = wholeRangeStep(value);
  if (step !== null) return `every ${ordinal(step)} day of the month`;
  const days = expand(value).map((day) => `the ${ordinal(day)}`);
  return `on ${list(days)} of the month`;
}

function dayOfWeekClause(value: FieldValue): string | null {
  if (value.unrestricted) return null;
  // 7 is Sunday in a crontab just as 0 is, so both land on the same name. Listed from Monday
  // rather than in the numeric order cron writes them, so a weekend reads "Saturdays and Sundays".
  const names = expand(value)
    .map((day) => day % 7)
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((day) => DAY_NAMES[day]);
  const unique = [...new Set(names)];
  const range = contiguous(value);
  if (range && range.to - range.from >= 2) {
    return `on ${DAY_NAMES[range.from % 7]} through ${DAY_NAMES[range.to % 7]}`;
  }
  return `on ${list(unique.map((name) => `${name}s`))}`;
}

function monthClause(value: FieldValue): string | null {
  if (value.unrestricted) return null;
  const step = wholeRangeStep(value);
  if (step !== null) return `every ${ordinal(step)} month`;
  return `in ${list(expand(value).map((month) => MONTH_NAMES[month - 1]))}`;
}

function ordinal(value: number): string {
  const rest = value % 100;
  if (rest >= 11 && rest <= 13) return `${value}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[value % 10] ?? "th";
  return `${value}${suffix}`;
}

/**
 * The whole expression as one sentence, or the first field that cannot be read.
 *
 * Day of month and day of week are joined with "or", not "and", because that is what cron does
 * with them: `0 9 1 * 1` fires on the 1st and on every Monday. With only one next occurrence shown
 * beneath, this sentence is the only place that surprise can be caught.
 */
export function describeExpression(cron: string): { text: string } | { error: string } {
  const tokens = cron.trim().split(/\s+/);
  if (tokens.length !== 5) {
    return { error: "A schedule is five fields: minute, hour, day of month, month, day of week" };
  }

  const parsed = parseExpression(tokens);
  const failed = parsed.findIndex(isError);
  if (failed >= 0) {
    const result = parsed[failed];
    return { error: isError(result) ? result.error : "" };
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed.map((result) =>
    isError(result) ? null : result.value,
  );
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return { error: "That schedule cannot be read" };
  }

  const days = [dayOfMonthClause(dayOfMonth), dayOfWeekClause(dayOfWeek)].filter(
    (clause) => clause !== null,
  );
  const clauses = [timeClause(minute, hour), days.join(" or "), monthClause(month)].filter(
    (clause) => clause !== null && clause.length > 0,
  );

  return { text: clauses.join(", ") };
}

/** The label under a slot, and the name used in its popover heading. */
export const FIELD_LABELS = FIELDS.map((field) => field.label);
