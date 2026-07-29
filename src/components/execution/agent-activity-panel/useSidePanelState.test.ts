import { describe, it, expect } from "vitest";
import { widthVerdict } from "./useSidePanelState";

// Panel minimums: stream 42rem, side panel 22rem.
describe("widthVerdict", () => {
  it("collapses below the two panels' combined minimum", () => {
    expect(widthVerdict(63 * 16, 16)).toBe("collapse");
  });

  it("keeps the current state between the minimum and twice the stream minimum", () => {
    expect(widthVerdict(64 * 16, 16)).toBe("keep");
    expect(widthVerdict(83 * 16, 16)).toBe("keep");
  });

  it("allows auto-expand at twice the stream minimum", () => {
    expect(widthVerdict(84 * 16, 16)).toBe("may-expand");
  });

  it("scales with the root font size", () => {
    expect(widthVerdict(84 * 16, 20)).toBe("keep");
    expect(widthVerdict(63 * 20, 20)).toBe("collapse");
  });
});
