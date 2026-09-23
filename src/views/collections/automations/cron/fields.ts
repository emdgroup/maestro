/**
 * One cron field, read.
 *
 * This parses a field and decides nothing. It says whether `9-17` is a thing an hour field may
 * hold and what it means in words, so a slot can turn red, a sentence can be written and a save
 * can be refused. When a schedule actually fires is the daemon's answer, and stays there, which is
 * why nothing here walks a calendar.
 */

export type FieldKind = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

export interface FieldSpec {
  kind: FieldKind;
  /** Under the slot. */
  label: string;
  min: number;
  max: number;
  /** Names for the values, indexed from `min`. Only the two fields that have any. */
  names?: string[];
}

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * The five, in the order they are written.
 *
 * Day of week runs to 7 because a crontab accepts both 0 and 7 for Sunday, and an expression
 * pasted from elsewhere may use either. What the daemon does with that is its own business.
 */
export const FIELDS: FieldSpec[] = [
  { kind: "minute", label: "minute", min: 0, max: 59 },
  { kind: "hour", label: "hour", min: 0, max: 23 },
  { kind: "dayOfMonth", label: "day of month", min: 1, max: 31 },
  { kind: "month", label: "month", min: 1, max: 12, names: MONTH_NAMES },
  { kind: "dayOfWeek", label: "day of week", min: 0, max: 7, names: DAY_NAMES },
];

/** One comma-separated piece of a field. `*` and `*\/5` are both a full-range part with a step. */
export interface FieldPart {
  from: number;
  to: number;
  /** 1 unless the part carried a `/`. */
  step: number;
  /** True when the part was written as a star rather than as an explicit range. */
  wildcard: boolean;
}

export interface FieldValue {
  parts: FieldPart[];
  /** True when this field constrains nothing: a single star, no step. */
  unrestricted: boolean;
}

function fail(message: string): { error: string } {
  return { error: message };
}

/**
 * Read one field's token.
 *
 * Returns the parsed value or the first thing wrong with it, said in that field's own terms
 * because the message is shown under that field's own slot.
 */
export function parseField(
  token: string,
  spec: FieldSpec,
): { value: FieldValue } | { error: string } {
  const trimmed = token.trim();
  if (trimmed.length === 0) return fail(`The ${spec.label} field cannot be empty`);

  const parts: FieldPart[] = [];
  for (const piece of trimmed.split(",")) {
    const [range, stepText, ...extra] = piece.split("/");
    if (extra.length > 0) return fail(`'${piece}' has more than one step`);

    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return fail(`'${stepText}' is not a step`);
      step = Number(stepText);
      if (step < 1) return fail("A step has to be 1 or more");
    }

    if (range === "*") {
      parts.push({ from: spec.min, to: spec.max, step, wildcard: true });
      continue;
    }

    const bounds = range.split("-");
    if (bounds.length > 2) return fail(`'${range}' is not a range`);
    const numbers = bounds.map((bound) => {
      const named = nameToNumber(bound, spec);
      return named ?? (/^\d+$/.test(bound.trim()) ? Number(bound) : NaN);
    });
    if (numbers.some((value) => Number.isNaN(value))) {
      return fail(`'${range}' is not a ${spec.label}`);
    }
    for (const value of numbers) {
      if (value < spec.min || value > spec.max) {
        return fail(
          `${spec.label === "day of week" ? "Days" : `${capitalize(spec.label)}s`} go from ${spec.min} to ${spec.max}, so ${value} never comes round`,
        );
      }
    }
    const [from, to = numbers[0]] = numbers;
    if (to < from) return fail(`'${range}' runs backwards`);
    parts.push({ from, to, step, wildcard: false });
  }

  return {
    value: {
      parts,
      unrestricted: parts.length === 1 && parts[0].wildcard && parts[0].step === 1,
    },
  };
}

/** `MON`, `mon`, `Monday`, `JAN`. Cron accepts the three-letter forms and so does what we store. */
function nameToNumber(text: string, spec: FieldSpec): number | null {
  if (!spec.names) return null;
  const needle = text.trim().toLowerCase();
  if (needle.length < 3) return null;
  const index = spec.names.findIndex((name) => name.toLowerCase().startsWith(needle.slice(0, 3)));
  if (index < 0) return null;
  return index + spec.min;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Every value a field's parts name, in order, deduplicated. */
export function expand(value: FieldValue): number[] {
  const seen = new Set<number>();
  for (const part of value.parts) {
    for (let at = part.from; at <= part.to; at += part.step) seen.add(at);
  }
  return [...seen].sort((a, b) => a - b);
}

/** The whole expression, field by field. Five tokens in, five readings or errors out. */
export function parseExpression(
  tokens: string[],
): Array<{ value: FieldValue } | { error: string }> {
  return FIELDS.map((spec, index) => parseField(tokens[index] ?? "", spec));
}

export function isError(
  result: { value: FieldValue } | { error: string },
): result is { error: string } {
  return "error" in result;
}
