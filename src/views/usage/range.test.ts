import { describe, expect, it } from "vitest";
import { bucketKeys, describeDates, heatmapShown, resolveRange } from "./range";

const now = new Date(2026, 9, 11, 14, 5, 30);

describe("resolveRange", () => {
  it.each([
    ["1h", 60, "minute"],
    ["1d", 24, "hour"],
    ["7d", 7, "day"],
    ["30d", 30, "day"],
    ["12m", 12, "month"],
  ] as const)("cuts %s into %i %s bars", (preset, bars, bucket) => {
    const range = resolveRange({ preset }, now);
    expect(range.bucket).toBe(bucket);
    expect(bucketKeys(range, undefined)).toHaveLength(bars);
  });

  it("ends the bars at the current one", () => {
    const keys = bucketKeys(resolveRange({ preset: "7d" }, now), undefined);
    expect(keys[0]).toBe("2026-10-05");
    expect(keys[keys.length - 1]).toBe("2026-10-11");
  });

  it("starts All time at the earliest record", () => {
    const keys = bucketKeys(resolveRange({ preset: "all" }, now), "2026-05");
    expect(keys).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  });

  it.each([
    [new Date(2026, 9, 9), "hour", 72],
    [new Date(2026, 8, 12), "day", 30],
    [new Date(2026, 0, 1), "month", 10],
  ] as const)("cuts a custom range from %s by %s", (from, bucket, bars) => {
    const range = resolveRange({ from, to: new Date(2026, 9, 11) }, now);
    expect(range.bucket).toBe(bucket);
    expect(bucketKeys(range, undefined)).toHaveLength(bars);
  });
});

describe("heatmapShown", () => {
  it("needs a week", () => {
    expect(heatmapShown({ preset: "1d" })).toBe(false);
    expect(heatmapShown({ preset: "7d" })).toBe(true);
    expect(heatmapShown({ from: new Date(2026, 9, 5), to: new Date(2026, 9, 10) })).toBe(false);
    expect(heatmapShown({ from: new Date(2026, 9, 5), to: new Date(2026, 9, 11) })).toBe(true);
  });
});

describe("describeDates", () => {
  it("names the last day a custom range covers", () => {
    const range = resolveRange({ from: new Date(2026, 8, 12), to: new Date(2026, 9, 11) }, now);
    expect(describeDates(range, undefined)).toBe("Sep 12 – Oct 11, 2026");
  });
});
