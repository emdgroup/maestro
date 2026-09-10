import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatElapsed,
  formatTimeAgoCompact,
  formatTimeAgoLong,
  humanizeTokenCount,
  plural,
} from "./format-utils";

const NOW = new Date("2026-07-29T12:00:00Z").getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * These cover what used to be six formatters in five files. Two of them — `activityStatus`'s
 * `formatTimeAgo` and `MessageActionBar`'s `relativeTime` — had tests of their own; those cases
 * are carried over verbatim below so the consolidation is held to what they already promised.
 */
describe("formatTimeAgoCompact", () => {
  it("describes the span in the largest unit that fits", () => {
    expect(formatTimeAgoCompact(NOW, NOW)).toBe("just now");
    expect(formatTimeAgoCompact(NOW - 59_999, NOW)).toBe("just now");
    expect(formatTimeAgoCompact(NOW - MINUTE, NOW)).toBe("1m ago");
    expect(formatTimeAgoCompact(NOW - 59 * MINUTE, NOW)).toBe("59m ago");
    expect(formatTimeAgoCompact(NOW - HOUR, NOW)).toBe("1h ago");
    expect(formatTimeAgoCompact(NOW - 23 * HOUR, NOW)).toBe("23h ago");
  });

  /// Past a day, counting hours stops saying anything a person can use — `72h ago` is arithmetic,
  /// not a date. Two of the formatters this replaces had no rollover and did print `72h ago`.
  it("falls back to a date once hours stop being useful", () => {
    expect(formatTimeAgoCompact(NOW - DAY, NOW)).toBe("Jul 28");
    expect(formatTimeAgoCompact(NOW - 5 * DAY, NOW)).toBe("Jul 24");
  });

  /// A status change re-stamps its timestamp mid-tick, so `now` can be behind the value it is
  /// subtracted from. Unclamped this counted backwards.
  it("treats a clock-skewed future stamp as just now, not negative", () => {
    expect(formatTimeAgoCompact(NOW + 5_000, NOW)).toBe("just now");
    expect(formatTimeAgoCompact(NOW + DAY, NOW)).toBe("just now");
  });

  it("accepts the ISO strings backend rows carry", () => {
    expect(formatTimeAgoCompact("2026-07-29T11:00:00Z", NOW)).toBe("1h ago");
  });

  /// A row with an unreadable timestamp should lose its subtitle, not render "Invalid Date".
  it("gives nothing for an unparseable input", () => {
    expect(formatTimeAgoCompact("not a date", NOW)).toBe("");
    expect(formatTimeAgoCompact(Number.NaN, NOW)).toBe("");
  });
});

describe("formatTimeAgoLong", () => {
  it("reads as just now under a minute", () => {
    expect(formatTimeAgoLong(NOW, NOW)).toBe("just now");
    expect(formatTimeAgoLong(NOW - 59_000, NOW)).toBe("just now");
  });

  it("counts minutes and hours past that", () => {
    expect(formatTimeAgoLong(NOW - 2 * MINUTE, NOW)).toBe("2 minutes ago");
    expect(formatTimeAgoLong(NOW - 3 * HOUR, NOW)).toBe("about 3 hours ago");
  });

  it("treats a clock-skewed future stamp as just now, not negative", () => {
    expect(formatTimeAgoLong(NOW + 5_000, NOW)).toBe("just now");
  });

  it("accepts the ISO strings backend rows carry", () => {
    expect(formatTimeAgoLong("2026-07-29T09:00:00Z", NOW)).toBe("about 3 hours ago");
  });

  it("gives nothing for an unparseable input", () => {
    expect(formatTimeAgoLong("not a date", NOW)).toBe("");
  });
});

describe("formatBytes", () => {
  it("steps up a unit at each boundary", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1024.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5 * 1024 * 1024 + 512 * 1024)).toBe("5.5 MB");
  });
});

describe("plural", () => {
  it("suffixes everything except one", () => {
    expect(plural(0, "commit")).toBe("0 commits");
    expect(plural(1, "commit")).toBe("1 commit");
    expect(plural(2, "commit")).toBe("2 commits");
  });
});

describe("formatElapsed", () => {
  it("pads the seconds", () => {
    expect(formatElapsed(0)).toBe("0m 00s");
    expect(formatElapsed(9)).toBe("0m 09s");
    expect(formatElapsed(61)).toBe("1m 01s");
  });
});

describe("humanizeTokenCount", () => {
  it("keeps small counts exact and abbreviates the rest", () => {
    expect(humanizeTokenCount(999)).toBe("999");
    expect(humanizeTokenCount(1_000)).toBe("1k");
    expect(humanizeTokenCount(1_500)).toBe("1.5k");
    expect(humanizeTokenCount(15_000)).toBe("15k");
    expect(humanizeTokenCount(1_500_000)).toBe("1.5M");
  });
});
