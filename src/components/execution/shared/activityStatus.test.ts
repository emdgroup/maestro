import { describe, expect, it } from "vitest";
import { formatElapsedCompact } from "./activityStatus";

describe("formatElapsedCompact", () => {
  it("floors to whole seconds and pads", () => {
    expect(formatElapsedCompact(0)).toBe("0:00");
    expect(formatElapsedCompact(999)).toBe("0:00");
    expect(formatElapsedCompact(1_000)).toBe("0:01");
    expect(formatElapsedCompact(9_000)).toBe("0:09");
    expect(formatElapsedCompact(59_999)).toBe("0:59");
    expect(formatElapsedCompact(60_000)).toBe("1:00");
    expect(formatElapsedCompact(3_661_000)).toBe("61:01");
  });

  // A status change re-stamps `stateChangedAt` mid-tick, so ElapsedTime subtracts it from a
  // `now` that is up to a second stale. Unclamped this floored to -1 and rendered "-1:-1".
  it("reports 0:00 for a span that has not elapsed yet", () => {
    expect(formatElapsedCompact(-1)).toBe("0:00");
    expect(formatElapsedCompact(-999)).toBe("0:00");
    expect(formatElapsedCompact(-1_000)).toBe("0:00");
    expect(formatElapsedCompact(-60_000)).toBe("0:00");
  });
});
