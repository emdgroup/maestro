import { describe, expect, it } from "vitest";
import { describeExpression } from "./describe";
import { expand, FIELDS, isError, parseField } from "./fields";
import { SCHEDULE_TEMPLATES } from "./templates";

const [MINUTE, HOUR, DAY_OF_MONTH, MONTH, DAY_OF_WEEK] = FIELDS;

function value(token: string, spec = HOUR) {
  const result = parseField(token, spec);
  if (isError(result)) throw new Error(`expected ${token} to parse: ${result.error}`);
  return result.value;
}

function error(token: string, spec = HOUR): string {
  const result = parseField(token, spec);
  if (!isError(result)) throw new Error(`expected ${token} to be refused`);
  return result.error;
}

describe("parseField", () => {
  it("reads every form a field can hold", () => {
    expect(expand(value("*"))).toHaveLength(24);
    expect(expand(value("9"))).toEqual([9]);
    expect(expand(value("9-12"))).toEqual([9, 10, 11, 12]);
    expect(expand(value("9,13,17"))).toEqual([9, 13, 17]);
    expect(expand(value("*/6"))).toEqual([0, 6, 12, 18]);
    expect(expand(value("9-17/4"))).toEqual([9, 13, 17]);
  });

  it("takes the names cron takes", () => {
    expect(expand(value("Mon", DAY_OF_WEEK))).toEqual([1]);
    expect(expand(value("mon-fri", DAY_OF_WEEK))).toEqual([1, 2, 3, 4, 5]);
    expect(expand(value("Jan,Jul", MONTH))).toEqual([1, 7]);
  });

  it("refuses a value the field cannot hold, in that field's own words", () => {
    expect(error("25")).toContain("0 to 23");
    expect(error("60", MINUTE)).toContain("0 to 59");
    expect(error("0", DAY_OF_MONTH)).toContain("1 to 31");
    expect(error("8", DAY_OF_WEEK)).toContain("0 to 7");
  });

  it("refuses what is not a field at all", () => {
    expect(error("")).toContain("cannot be empty");
    expect(error("nine")).toContain("not a hour");
    expect(error("17-9")).toContain("backwards");
    expect(error("*/0")).toContain("1 or more");
    expect(error("*/2/3")).toContain("more than one step");
  });

  it("knows when a field constrains nothing", () => {
    expect(value("*").unrestricted).toBe(true);
    expect(value("*/2").unrestricted).toBe(false);
    expect(value("0-23").unrestricted).toBe(false);
  });
});

describe("describeExpression", () => {
  function say(cron: string): string {
    const result = describeExpression(cron);
    if ("error" in result) throw new Error(`expected ${cron} to describe: ${result.error}`);
    return result.text;
  }

  it("says what the time fields mean together", () => {
    expect(say("*/30 * * * *")).toBe("Every 30 minutes");
    expect(say("0 * * * *")).toBe("Every hour, on the hour");
    expect(say("15 * * * *")).toBe("Every hour, at 15 minutes past");
    expect(say("0 */2 * * *")).toBe("Every 2 hours, on the hour");
    expect(say("0 9 * * *")).toBe("Every day at 09:00");
    expect(say("30 9,17 * * *")).toBe("Every day at 09:30 and 17:30");
    expect(say("*/30 9-17 * * *")).toBe("Every 30 minutes, between 09:00 and 17:59");
    expect(say("* * * * *")).toBe("Every minute");
  });

  it("says which days", () => {
    expect(say("0 9 * * 1-5")).toBe("At 09:00, on Monday through Friday");
    expect(say("0 9 * * 1")).toBe("At 09:00, on Mondays");
    expect(say("0 10 * * 6,0")).toBe("At 10:00, on Saturdays and Sundays");
    expect(say("0 7 1 * *")).toBe("At 07:00, on the 1st of the month");
    expect(say("0 7 1,15 * *")).toBe("At 07:00, on the 1st and the 15th of the month");
    expect(say("0 7 1 */3 *")).toBe("At 07:00, on the 1st of the month, every 3rd month");
  });

  it("says or, because that is what cron does with both day fields", () => {
    // The trap: this fires on the 1st and on every Monday, not on Mondays that fall on the 1st.
    expect(say("0 9 1 * 1")).toBe("At 09:00, on the 1st of the month or on Mondays");
  });

  it("treats 7 and 0 as the same Sunday", () => {
    expect(say("0 9 * * 7")).toBe("At 09:00, on Sundays");
  });

  it("hands back the first field that cannot be read", () => {
    expect(describeExpression("0 25 * * *")).toEqual({
      error: "Hours go from 0 to 23, so 25 never comes round",
    });
    expect(describeExpression("0 9 * *")).toEqual({
      error: "A schedule is five fields: minute, hour, day of month, month, day of week",
    });
  });

  it("describes every template, so the menu can never show one it cannot read", () => {
    // The menu labels are these same readings, which is the point: a hand-written label that
    // disagreed with the sentence would promise one schedule and describe another.
    expect(SCHEDULE_TEMPLATES.map(say)).toEqual([
      "Every 15 minutes",
      "Every 2 hours, on the hour",
      "Every day at 09:00",
      "Every day at 09:00 and 17:00",
      "At 09:00, on Monday through Friday",
      "At 08:00, on Mondays",
      "At 10:00, on Saturdays and Sundays",
      "Every 30 minutes, between 09:00 and 17:59, on Monday through Friday",
      "At 07:00, on the 1st of the month",
      "At 07:00, on the 1st of the month, every 3rd month",
    ]);
  });
});
