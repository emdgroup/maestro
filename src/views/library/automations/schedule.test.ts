import { describe, expect, it } from "vitest";
import { describeNextRun, describeSchedule, isDue, nextRun } from "./schedule";
import type { Automation, AutomationSchedule } from "@/types/bindings";

const daily: AutomationSchedule = { kind: "Daily", time: "09:00", weekday: null };

// 2026-09-16 is a Wednesday, so a weekday walk and a weekend walk are both reachable from it.
const wednesdayMorning = new Date(2026, 8, 16, 8, 0);

describe("nextRun", () => {
  it("takes today's occurrence when it is still ahead", () => {
    expect(nextRun(daily, wednesdayMorning)).toEqual(new Date(2026, 8, 16, 9, 0));
  });

  it("rolls to tomorrow once today's has passed", () => {
    expect(nextRun(daily, new Date(2026, 8, 16, 9, 30))).toEqual(new Date(2026, 8, 17, 9, 0));
  });

  it("does not fire the same occurrence twice on an exact hit", () => {
    // A tick landing on the minute is the common case, and `>=` here would re-fire it forever.
    expect(nextRun(daily, new Date(2026, 8, 16, 9, 0))).toEqual(new Date(2026, 8, 17, 9, 0));
  });

  it("skips the weekend for Weekdays", () => {
    const friday = new Date(2026, 8, 18, 10, 0);
    const schedule: AutomationSchedule = { kind: "Weekdays", time: "09:00", weekday: null };
    expect(nextRun(schedule, friday)).toEqual(new Date(2026, 8, 21, 9, 0));
  });

  it("walks to the named weekday for Weekly", () => {
    const schedule: AutomationSchedule = { kind: "Weekly", time: "09:00", weekday: 1 };
    expect(nextRun(schedule, wednesdayMorning)).toEqual(new Date(2026, 8, 21, 9, 0));
  });
});

describe("isDue", () => {
  const automation = {
    enabled: true,
    schedule: daily,
  } as Automation;

  const nineOClock = new Date(2026, 8, 16, 9, 0).getTime();

  it("fires once the time has come round", () => {
    expect(isDue(automation, wednesdayMorning.getTime(), nineOClock)).toBe(true);
  });

  it("does not fire again on the next tick", () => {
    // What the tick does after firing: the floor becomes the fire's own time.
    expect(isDue(automation, nineOClock, nineOClock + 60_000)).toBe(false);
  });

  it("ignores a disabled automation and one with no schedule", () => {
    expect(isDue({ ...automation, enabled: false }, wednesdayMorning.getTime(), nineOClock)).toBe(
      false,
    );
    expect(isDue({ ...automation, schedule: null }, wednesdayMorning.getTime(), nineOClock)).toBe(
      false,
    );
  });
});

describe("describeSchedule", () => {
  it("names each kind", () => {
    expect(describeSchedule(null)).toBe("Manual only");
    expect(describeSchedule(daily)).toBe("Daily at 09:00");
    expect(describeSchedule({ kind: "Weekdays", time: "07:30", weekday: null })).toBe(
      "Weekdays at 07:30",
    );
    expect(describeSchedule({ kind: "Weekly", time: "18:00", weekday: 5 })).toBe(
      "Fridays at 18:00",
    );
  });
});

describe("describeNextRun", () => {
  it("says today, tomorrow, or the weekday", () => {
    expect(describeNextRun(new Date(2026, 8, 16, 21, 0), wednesdayMorning)).toContain("today");
    expect(describeNextRun(new Date(2026, 8, 17, 9, 0), wednesdayMorning)).toContain("tomorrow");
    expect(describeNextRun(new Date(2026, 8, 21, 9, 0), wednesdayMorning)).toContain("Monday");
  });
});
