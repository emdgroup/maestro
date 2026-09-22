import { describe, expect, it } from "vitest";
import { describeNextRun, describeSchedule, fromCron, MANUAL, toCron } from "./schedule";

describe("toCron", () => {
  it("writes the three presets as standard five-field cron", () => {
    expect(toCron({ kind: "Daily", time: "09:00", weekday: 1 })).toBe("0 9 * * *");
    expect(toCron({ kind: "Weekdays", time: "18:30", weekday: 1 })).toBe("30 18 * * 1-5");
    expect(toCron({ kind: "Weekly", time: "07:05", weekday: 0 })).toBe("5 7 * * 0");
  });

  it("gives a manual automation no schedule at all", () => {
    expect(toCron(MANUAL)).toBeNull();
  });

  it("refuses a time that is not one", () => {
    expect(toCron({ kind: "Daily", time: "", weekday: 1 })).toBeNull();
    expect(toCron({ kind: "Daily", time: "nine", weekday: 1 })).toBeNull();
  });
});

describe("fromCron", () => {
  it("round-trips every preset the editor can produce", () => {
    for (const preset of [
      { kind: "Daily", time: "09:00", weekday: 1 },
      { kind: "Weekdays", time: "18:30", weekday: 1 },
      { kind: "Weekly", time: "07:05", weekday: 6 },
    ] as const) {
      const cron = toCron(preset);
      expect(fromCron(cron)).toEqual(preset);
    }
  });

  it("reads no schedule as manual", () => {
    expect(fromCron(null)).toEqual(MANUAL);
    expect(fromCron("")).toEqual(MANUAL);
  });

  it("returns null for an expression no preset can express", () => {
    // Hand-written schedules are kept and shown as they are, rather than flattened into the
    // nearest preset, which would change when the automation runs.
    expect(fromCron("*/15 * * * *")).toBeNull();
    expect(fromCron("0 9 1 * *")).toBeNull();
    expect(fromCron("0 9 * * 1,3")).toBeNull();
    expect(fromCron("0 9 * *")).toBeNull();
  });
});

describe("describeSchedule", () => {
  it("says what a preset means", () => {
    expect(describeSchedule(null)).toBe("Manual only");
    expect(describeSchedule("0 9 * * *")).toBe("Daily at 09:00");
    expect(describeSchedule("30 18 * * 1-5")).toBe("Weekdays at 18:30");
    expect(describeSchedule("0 7 * * 2")).toBe("Tuesdays at 07:00");
  });

  it("shows an expression it cannot name verbatim", () => {
    expect(describeSchedule("*/15 * * * *")).toBe("*/15 * * * *");
  });
});

describe("describeNextRun", () => {
  it("names the day relative to now", () => {
    const now = new Date(2026, 0, 1, 12, 0);
    expect(describeNextRun(new Date(2026, 0, 1, 15, 0), now)).toMatch(/^today at /);
    expect(describeNextRun(new Date(2026, 0, 2, 9, 0), now)).toMatch(/^tomorrow at /);
    expect(describeNextRun(new Date(2026, 0, 5, 9, 0), now)).toMatch(/^Monday at /);
  });
});
