import { describe, it, expect } from "vitest";
import { parseProfileOverrides, isRoleSkipped, profileIdFor } from "./profile-overrides";

/**
 * The map has three states and only two of them are visible in its type, which is what these pin.
 * The twin of `role_is_skipped` in `src-tauri/src/project/profiles.rs`, and wrong in the same way
 * if either drifts.
 */
describe("profile overrides", () => {
  it("reads a named profile, a skipped stage and an absent role apart", () => {
    const overrides = parseProfileOverrides('{"Reviewer":"strict","Planner":null}');

    expect(profileIdFor(overrides, "Reviewer")).toBe("strict");
    expect(isRoleSkipped(overrides, "Reviewer")).toBe(false);

    expect(isRoleSkipped(overrides, "Planner")).toBe(true);
    expect(profileIdFor(overrides, "Planner")).toBeNull();

    // Absent is "the project decides", which is not "off" — the distinction a truthiness test
    // would lose, and the reason `isRoleSkipped` looks at key presence.
    expect(isRoleSkipped(overrides, "Refiner")).toBe(false);
    expect(profileIdFor(overrides, "Refiner")).toBeNull();
  });

  /** A task that cannot be started is worse than one that starts on the project's defaults. */
  it("treats an unreadable value as no overrides at all", () => {
    for (const raw of [null, undefined, "", "{", "[]", '"Planner"']) {
      const overrides = parseProfileOverrides(raw);
      expect(overrides).toEqual({});
      expect(isRoleSkipped(overrides, "Planner")).toBe(false);
    }
  });
});
