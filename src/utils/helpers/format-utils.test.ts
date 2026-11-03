import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatElapsed,
  formatTimeAgoCompact,
  formatTimeAgoLong,
  formatTokens,
  formatCost,
  relativeAge,
  formatElapsedCompact,
  formatCountdown,
  formatUptime,
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

  /**
   * Past a day, counting hours stops saying anything a person can use — `72h ago` is arithmetic,
   * not a date. Two of the formatters this replaces had no rollover and did print `72h ago`.
   */
  it("falls back to a date once hours stop being useful", () => {
    expect(formatTimeAgoCompact(NOW - DAY, NOW)).toBe("Jul 28");
    expect(formatTimeAgoCompact(NOW - 5 * DAY, NOW)).toBe("Jul 24");
  });

  /**
   * A status change re-stamps its timestamp mid-tick, so `now` can be behind the value it is
   * subtracted from. Unclamped this counted backwards.
   */
  it("treats a clock-skewed future stamp as just now, not negative", () => {
    expect(formatTimeAgoCompact(NOW + 5_000, NOW)).toBe("just now");
    expect(formatTimeAgoCompact(NOW + DAY, NOW)).toBe("just now");
  });

  it("accepts the ISO strings backend rows carry", () => {
    expect(formatTimeAgoCompact("2026-07-29T11:00:00Z", NOW)).toBe("1h ago");
  });

  /** A row with an unreadable timestamp should lose its subtitle, not render "Invalid Date". */
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

describe("relativeAge", () => {
  const now = Date.parse("2026-08-29T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("floors at one minute", () => {
    expect(relativeAge(ago(2_000), now)).toBe("1 min");
    expect(relativeAge(ago(59_000), now)).toBe("1 min");
  });

  it("steps up through the units", () => {
    expect(relativeAge(ago(5 * 60_000), now)).toBe("5 min");
    expect(relativeAge(ago(3 * 3_600_000), now)).toBe("3 h");
    expect(relativeAge(ago(2 * 86_400_000), now)).toBe("2 d");
    expect(relativeAge(ago(21 * 86_400_000), now)).toBe("3 w");
  });

  // Clock skew between a remote worktree's host and this one must not read as "in 3 minutes".
  it("floors a timestamp from the future rather than counting forward", () => {
    expect(relativeAge(ago(-5 * 60_000), now)).toBe("1 min");
  });

  it("returns nothing it cannot parse", () => {
    expect(relativeAge(null, now)).toBeNull();
    expect(relativeAge("not a date", now)).toBeNull();
  });
});

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

describe("formatCountdown", () => {
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

describe("formatUptime", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  it("shows the two largest units", () => {
    expect(formatUptime("2026-10-02T06:00:00Z", now)).toBe("3d 6h");
    expect(formatUptime("2026-10-05T07:48:00Z", now)).toBe("4h 12m");
    expect(formatUptime("2026-10-05T11:51:00Z", now)).toBe("9m");
  });
});

describe("formatTokens", () => {
  it("keeps small counts exact and abbreviates the rest", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1K");
    expect(formatTokens(1_500)).toBe("1.5K");
    expect(formatTokens(106_900)).toBe("106.9K");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});

describe("formatCost", () => {
  it("shows cents below a thousand and whole units above", () => {
    expect(formatCost(0.4)).toBe("$0.40");
    expect(formatCost(142.18)).toBe("$142.18");
    expect(formatCost(1234.5)).toBe("$1,235");
    expect(formatCost(2, "EUR")).toBe("€2.00");
  });

  it("falls back for a currency Intl does not know", () => {
    expect(formatCost(1.2, "NOPE1")).toBe("1.20 NOPE1");
  });
});
