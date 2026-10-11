import { describe, expect, it } from "vitest";
import {
  elapsedShare,
  formatCountdown,
  limitReachedNotice,
  liveWindows,
  parsePlanLimits,
  windowTone,
} from "./planLimits";

const NOW = 1_791_670_000;

/** As claude-agent-acp 0.86 sent it in a probe. */
function update(info: Record<string, unknown>) {
  return { sessionUpdate: "usage_update", used: 1, size: 2, _meta: { "_claude/rateLimit": info } };
}
const allowed = {
  status: "allowed",
  resetsAt: NOW + 2 * 3600,
  rateLimitType: "five_hour",
  overageStatus: "rejected",
  overageDisabledReason: "org_level_disabled",
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 0.12, resetsAt: NOW + 2 * 3600 },
    seven_day: { utilization: 0.21, resetsAt: NOW + 15 * 3600 },
  },
};

describe("planLimits", () => {
  it("reads both windows and ignores updates without limits", () => {
    const limits = parsePlanLimits(update(allowed), 5)!;
    expect(limits.windows.fiveHour).toEqual({ utilization: 0.12, resetsAt: NOW + 7200 });
    expect(limits.windows.sevenDay?.utilization).toBe(0.21);
    expect(limits.overageDisabledReason).toBe("org_level_disabled");
    expect(limits.receivedAt).toBe(5);
    expect(parsePlanLimits({ sessionUpdate: "usage_update", used: 1 })).toBeNull();
  });

  it("is ahead once a larger share of the budget is spent than of the window", () => {
    const limits = parsePlanLimits(update(allowed))!;
    // Three of the five hours are gone.
    expect(elapsedShare(limits.windows.fiveHour!, "fiveHour", NOW)).toBeCloseTo(0.6);
    expect(windowTone(limits, "fiveHour", NOW)).toBe("ok");
    const spent = parsePlanLimits(
      update({
        ...allowed,
        unifiedWindows: { five_hour: { utilization: 0.7, resetsAt: NOW + 7200 } },
      }),
    )!;
    expect(windowTone(spent, "fiveHour", NOW)).toBe("ahead");
    const warned = parsePlanLimits(update({ ...allowed, status: "allowed_warning" }))!;
    expect(windowTone(warned, "fiveHour", NOW)).toBe("ahead");
    expect(windowTone(warned, "sevenDay", NOW)).toBe("ok");
  });

  it("marks only the refused window reached, and owes the session one notice", () => {
    const refused = parsePlanLimits(update({ ...allowed, status: "rejected" }))!;
    expect(windowTone(refused, "fiveHour", NOW)).toBe("reached");
    expect(windowTone(refused, "sevenDay", NOW)).toBe("ok");
    expect(limitReachedNotice(refused)?.title).toBe("Claude 5-hour limit reached");
    expect(limitReachedNotice(parsePlanLimits(update(allowed))!)).toBeNull();
  });

  it("drops a window once it has reset", () => {
    const limits = parsePlanLimits(update(allowed))!;
    expect(liveWindows(limits, NOW)).toEqual(["fiveHour", "sevenDay"]);
    expect(liveWindows(limits, NOW + 3 * 3600)).toEqual(["sevenDay"]);
    expect(liveWindows(undefined, NOW)).toEqual([]);
  });

  it("counts down in days, hours, minutes, and seconds only in the last minute", () => {
    expect(formatCountdown(28 * 3600)).toBe("1d 4h");
    expect(formatCountdown(5 * 3600)).toBe("5h 00m");
    expect(formatCountdown(2 * 3600 + 5 * 60 + 30)).toBe("2h 05m");
    expect(formatCountdown(3599)).toBe("59m");
    expect(formatCountdown(65)).toBe("1m");
    expect(formatCountdown(59.9)).toBe("59s");
    expect(formatCountdown(-3)).toBe("0s");
  });
});
