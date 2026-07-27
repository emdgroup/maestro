import { describe, expect, it } from "vitest";
import { resolveProjectStartupTab } from "./useProjectStartupTab";

describe("resolveProjectStartupTab", () => {
  it("applies a valid startup tab once per project", () => {
    const first = resolveProjectStartupTab(1, "agents", null);
    expect(first).toEqual({ appliedForProjectId: 1, tab: "agents" });

    const repeated = resolveProjectStartupTab(1, "settings", first.appliedForProjectId);
    expect(repeated).toEqual({ appliedForProjectId: 1, tab: null });

    expect(resolveProjectStartupTab(2, "settings", repeated.appliedForProjectId)).toEqual({
      appliedForProjectId: 2,
      tab: "settings",
    });
  });

  it("ignores missing and invalid startup tabs", () => {
    expect(resolveProjectStartupTab(1, null, null)).toEqual({
      appliedForProjectId: null,
      tab: null,
    });
    expect(resolveProjectStartupTab(1, "unknown", null)).toEqual({
      appliedForProjectId: 1,
      tab: null,
    });
  });

  it("applies the preference again when the same project is reopened", () => {
    const closed = resolveProjectStartupTab(null, "worktrees", 1);
    expect(closed.appliedForProjectId).toBeNull();
    expect(resolveProjectStartupTab(1, "worktrees", closed.appliedForProjectId).tab).toBe(
      "worktrees",
    );
  });
});
