import { describe, it, expect } from "vitest";
import { slugifyName, taskBranchName, MAESTRO_BRANCH_PREFIX } from "./generateSessionName";

describe("slugifyName", () => {
  it("lowercases and kebabs", () => {
    expect(slugifyName("Fix Windows Path")).toBe("fix-windows-path");
  });

  it("collapses runs of punctuation into a single dash", () => {
    expect(slugifyName("feat: add  --  thing")).toBe("feat-add-thing");
  });

  it("strips leading and trailing dashes", () => {
    expect(slugifyName("  !hello!  ")).toBe("hello");
  });

  it("caps at 50 characters without leaving a trailing dash", () => {
    // 49 chars, then a space — the slice lands on the separator.
    const name = `${"a".repeat(49)} tail`;
    const slug = slugifyName(name);
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("returns an empty string when nothing survives", () => {
    expect(slugifyName("!!!")).toBe("");
  });
});

describe("taskBranchName", () => {
  /// The prefix is not decoration: `list_prunable_branches` decides what it may delete purely
  /// from it, so a task branch created outside the namespace can never be cleaned up.
  it("puts the branch inside the Maestro namespace", () => {
    expect(taskBranchName(12, "Fix Windows Path")).toBe("maestro/12-fix-windows-path");
    expect(taskBranchName(12, "Fix Windows Path").startsWith(MAESTRO_BRANCH_PREFIX)).toBe(true);
  });

  it("leads with the id so branches sort and grep by task", () => {
    expect(taskBranchName(7, "add caching")).toBe("maestro/7-add-caching");
  });

  it("stays a valid ref when the title slugs to nothing", () => {
    // Git accepts a trailing dash; what it would reject is an empty final segment.
    expect(taskBranchName(9, "!!!")).toBe("maestro/9-");
  });
});
