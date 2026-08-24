import { describe, expect, it } from "vitest";
import { ACCENT_COLORS, randomPresetHue, resolveProjectHue } from "./accentColors";

describe("ACCENT_COLORS", () => {
  it("has 16 distinct hues in 0-360", () => {
    expect(ACCENT_COLORS).toHaveLength(16);
    const hues = new Set(ACCENT_COLORS.map((c) => c.hue));
    expect(hues.size).toBe(16);
    for (const { hue } of ACCENT_COLORS) {
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe("randomPresetHue", () => {
  it("only ever returns a preset hue", () => {
    const presets = new Set(ACCENT_COLORS.map((c) => c.hue));
    for (let i = 0; i < 100; i++) {
      expect(presets.has(randomPresetHue())).toBe(true);
    }
  });
});

describe("resolveProjectHue", () => {
  it("prefers the explicit project hue", () => {
    expect(resolveProjectHue({ projectAccent: 145, globalAccent: 250, systemAccent: 30 })).toBe(
      145,
    );
  });

  it("falls back to the global hue when the project has none", () => {
    expect(resolveProjectHue({ projectAccent: null, globalAccent: 250, systemAccent: 30 })).toBe(
      250,
    );
  });

  it("falls back to the system hue when neither is set", () => {
    expect(resolveProjectHue({ projectAccent: null, globalAccent: null, systemAccent: 30 })).toBe(
      30,
    );
  });
});
