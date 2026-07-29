import { describe, it, expect } from "vitest";
import { relativeTime } from "./MessageActionBar";

const NOW = new Date("2026-07-29T12:00:00Z").getTime();

describe("relativeTime", () => {
  it("reads as just now under a minute", () => {
    expect(relativeTime(NOW, NOW)).toBe("just now");
    expect(relativeTime(NOW - 59_000, NOW)).toBe("just now");
  });

  it("counts minutes and hours past that", () => {
    expect(relativeTime(NOW - 2 * 60_000, NOW)).toBe("2 minutes ago");
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("about 3 hours ago");
  });

  it("treats a clock-skewed future stamp as just now, not negative", () => {
    expect(relativeTime(NOW + 5_000, NOW)).toBe("just now");
  });
});
