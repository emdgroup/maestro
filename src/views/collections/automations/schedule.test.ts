import { describe, expect, it } from "vitest";
import { describeNextRun, describeSchedule } from "./schedule";

describe("describeSchedule", () => {
  it("says what the row's schedule means, in the editor's words", () => {
    expect(describeSchedule(null)).toBe("Manual only");
    expect(describeSchedule("0 9 * * *")).toBe("Every day at 09:00");
    expect(describeSchedule("*/30 * * * *")).toBe("Every 30 minutes");
    expect(describeSchedule("0 9 * * 1-5")).toBe("At 09:00, on Monday through Friday");
  });

  it("shows an expression it cannot read as it is", () => {
    // Stored by an older build or written by hand. Rewriting it into something readable would
    // change when it fires.
    expect(describeSchedule("0 99 * * *")).toBe("0 99 * * *");
  });
});

describe("describeNextRun", () => {
  it("names the day relative to now", () => {
    const now = new Date(2026, 0, 1, 12, 0);
    expect(describeNextRun(new Date(2026, 0, 1, 15, 0), now)).toBe("today at 15:00");
    expect(describeNextRun(new Date(2026, 0, 2, 9, 0), now)).toBe("tomorrow at 09:00");
    // The day name itself is whatever this machine's locale calls Monday, so only the shape of
    // the answer is asserted: a named day rather than today or tomorrow, and a 24 hour time.
    const monday = describeNextRun(new Date(2026, 0, 5, 9, 0), now);
    expect(monday).toMatch(/ at 09:00$/);
    expect(monday).not.toMatch(/^(today|tomorrow)/);
  });

  it("gives a date once the weekday would be ambiguous", () => {
    const now = new Date(2026, 0, 1, 12, 0);
    expect(describeNextRun(new Date(2026, 1, 1, 7, 0), now)).toMatch(/^1 .+ at 07:00$/);
  });
});
