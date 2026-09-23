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
 * Above this many values, a field is described by its shape rather than by its members.
 *
 * `8-14` is seven days, and reading them out is both longer than the expression and harder to
 * check than "the 8th through the 14th". Three or fewer is where a list still reads as a list:
 * `1-5/2` is Mondays, Wednesdays and Fridays, which says more than "every 2nd day from Monday".
 */
const ENUMERATE_UP_TO = 3;

/** How one field says its values: a single one, a run of them, and a run taken in steps. */
interface PartWords {
  one: (value: number) => string;
  range: (from: number, to: number) => string;
  everyStep: (step: number) => string;
  rangeStep: (from: number, to: number, step: number) => string;
}

/**
 * One field, described by what was written rather than by what it expands to.
 *
 * The comma-separated parts the user typed are already the right granularity: each is one idea,
 * and there are as many of them as they chose to write. Expanding them and listing the result is
 * what turns `8-14` into seven ordinals and `*\/2` into sixteen.
 *
 * A part small enough to read as a list still becomes one, because "Monday, Wednesday and Friday"
 * beats "every 2nd day from Monday through Friday" at three values.
 */
function describeParts(value: FieldValue, words: PartWords): string {
  const phrases = value.parts.map((part) => {
    const values: number[] = [];
    for (let at = part.from; at <= part.to; at += part.step) values.push(at);

    if (values.length <= ENUMERATE_UP_TO) return list(values.map(words.one));
    if (part.wildcard) return words.everyStep(part.step);
    if (part.step === 1) return words.range(part.from, part.to);
    return words.rangeStep(part.from, part.to, part.step);
  });
  return list(phrases);
}

const HOUR_WORDS: PartWords = {
  one: (hour) => `${pad(hour)}:00`,
  range: (from, to) => `${pad(from)}:00 through ${pad(to)}:00`,
  everyStep: (step) => `every ${ordinal(step)} hour`,
  rangeStep: (from, to, step) =>
    `every ${ordinal(step)} hour from ${pad(from)}:00 through ${pad(to)}:00`,
};

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
    return `${every}, during ${describeParts(hour, HOUR_WORDS)}`;
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

  if (hourRange && minutes.length === 1) {
    return `Every hour from ${pad(hourRange.from)}:${pad(minutes[0])} to ${pad(hourRange.to)}:${pad(minutes[0])}`;
  }

  const times = expand(hour).flatMap((at) => minutes.map((minute) => `${pad(at)}:${pad(minute)}`));
  if (times.length <= ENUMERATE_UP_TO + 1) return `At ${list(times)}`;

  // Too many clock times to read out, which is what an hour list crossed with a minute list does:
  // four hours and three minutes is twelve. Said once each instead.
  const past =
    minutes.length === 1 && minutes[0] === 0
      ? "on the hour"
      : `at ${list(minutes.map(String))} minutes past`;
  return `During ${describeParts(hour, HOUR_WORDS)}, ${past}`;
}

function dayOfMonthClause(value: FieldValue): string | null {
  if (value.unrestricted) return null;
  const phrase = describeParts(value, {
    one: (day) => `the ${ordinal(day)}`,
    range: (from, to) => `the ${ordinal(from)} through the ${ordinal(to)}`,
    everyStep: (step) => `every ${ordinal(step)} day`,
    rangeStep: (from, to, step) =>
      `every ${ordinal(step)} day from the ${ordinal(from)} through the ${ordinal(to)}`,
  });
  return `on ${phrase} of the month`;
}

/** 7 is Sunday in a crontab just as 0 is, so both land on the same name. */
function dayName(day: number): string {
  return DAY_NAMES[day % 7];
}

function dayOfWeekClause(value: FieldValue): string | null {
  if (value.unrestricted) return null;
  const phrase = describeParts(value, {
    one: (day) => `${dayName(day)}s`,
    range: (from, to) => `${dayName(from)} through ${dayName(to)}`,
    everyStep: (step) => `every ${ordinal(step)} day of the week`,
    rangeStep: (from, to, step) =>
      `every ${ordinal(step)} day from ${dayName(from)} through ${dayName(to)}`,
  });
  return `on ${phrase}`;
}

function monthClause(value: FieldValue): string | null {
  if (value.unrestricted) return null;
  const phrase = describeParts(value, {
    one: (month) => MONTH_NAMES[month - 1],
    range: (from, to) => `${MONTH_NAMES[from - 1]} through ${MONTH_NAMES[to - 1]}`,
    everyStep: (step) => `every ${ordinal(step)} month`,
    rangeStep: (from, to, step) =>
      `every ${ordinal(step)} month from ${MONTH_NAMES[from - 1]} through ${MONTH_NAMES[to - 1]}`,
  });
  // A step over the whole year is a cadence rather than a set of months, so it reads on its own.
  return value.parts.every((part) => part.wildcard) ? phrase : `in ${phrase}`;
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
  const month_ = monthClause(month);
  let time = timeClause(minute, hour);
  // "At 09:00" on its own does not say how often. Nothing restricts the day, so it is every one,
  // and saying that is the difference between a time and a schedule. Only for the clauses that
  // name a clock time: "Every day every 30 minutes" says it twice.
  // Only the day fields decide this. A schedule restricted to June still runs every day of it.
  if (days.length === 0 && time.startsWith("At ")) {
    time = `Every day ${time.replace("At ", "at ")}`;
  }
  const clauses = [time, days.join(" or "), month_].filter(
    (clause) => clause !== null && clause.length > 0,
  );

  return { text: clauses.join(", ") };
}

/** The label under a slot, and the name used in its popover heading. */
export const FIELD_LABELS = FIELDS.map((field) => field.label);
