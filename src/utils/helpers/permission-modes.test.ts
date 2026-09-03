import { describe, it, expect } from "vitest";
import { resolveAutomaticMode, isReadOnlyRole } from "./permission-modes";

/// This decides what an agent is allowed to do when a profile names no mode, which is the common
/// case — so it is worth pinning independently of either caller. Settings labels its automatic
/// option with it and the spawn path sets the mode with it; a change here changes both.
describe("resolveAutomaticMode", () => {
  it("prefers the strongest writable mode the agent offers", () => {
    expect(resolveAutomaticMode(["bypassPermissions", "auto", "default"], false)).toBe("auto");
  });

  it("prefers the strongest read-only mode the agent offers", () => {
    expect(resolveAutomaticMode(["default", "auto", "plan", "readonly"], true)).toBe("readonly");
  });

  /// `default` is the answer for either role when the preference list finds nothing, because it
  /// decides nothing: a write becomes a prompt rather than being allowed or refused.
  it("falls back to the default mode for either role", () => {
    expect(resolveAutomaticMode(["default", "acceptEdits"], false)).toBe("default");
    expect(resolveAutomaticMode(["default", "acceptEdits"], true)).toBe("default");
  });

  /// The safety property. An agent offering neither a read-only mode nor `default` has said it
  /// cannot hold this role, and the least bad writable mode is still a writable mode handed to a
  /// role whose whole point is not having one. Nothing is picked and the agent keeps its own.
  it("refuses to fall back to a writable mode for a read-only role", () => {
    expect(resolveAutomaticMode(["auto", "bypassPermissions"], true)).toBeNull();
  });

  it("has no answer when the agent offers nothing", () => {
    expect(resolveAutomaticMode([], false)).toBeNull();
    expect(resolveAutomaticMode([], true)).toBeNull();
  });
});

describe("isReadOnlyRole", () => {
  it("admits only the coder as a writer", () => {
    expect(isReadOnlyRole("Coder")).toBe(false);
    expect(isReadOnlyRole("Refiner")).toBe(true);
    expect(isReadOnlyRole("Planner")).toBe(true);
    expect(isReadOnlyRole("Reviewer")).toBe(true);
  });
});
