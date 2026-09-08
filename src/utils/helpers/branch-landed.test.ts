import { describe, it, expect } from "vitest";
import { branchHasLanded } from "./branch-landed";
import type { BranchPullRequestState } from "@/types/bindings";

const SHA = "8a5dd4a318dca5ac6504e3b60ec34ded225d245a";

function pullRequest(state: BranchPullRequestState, head_sha: string | null = SHA) {
  return { state, head_sha };
}

function worktree(overrides: { head_sha?: string; changed_files_count?: number } = {}) {
  return { head_sha: SHA, changed_files_count: 0, ...overrides };
}

describe("branchHasLanded", () => {
  /// The reported case: #336 merged, GitHub deleted the head branch, the remote-tracking ref was
  /// pruned — and the Changes card went on offering "Commit and push" for work already in main.
  it("lands when a merged pull request sits on the worktree's own HEAD", () => {
    expect(branchHasLanded(pullRequest("Merged"), worktree())).toBe(true);
  });

  /// The head-sha equality is the whole reason this is a refinement rather than "a merged pull
  /// request silences the card forever". New commits after the merge are new work to ship.
  it("does not land once HEAD has moved past the merged commit", () => {
    expect(branchHasLanded(pullRequest("Merged"), worktree({ head_sha: "c0ffee" }))).toBe(false);
  });

  it("does not land for a pull request that has not merged", () => {
    expect(branchHasLanded(pullRequest("Open"), worktree())).toBe(false);
    expect(branchHasLanded(pullRequest("Closed"), worktree())).toBe(false);
  });

  /// Uncommitted work outranks the merge: there is something to ship whatever the forge says.
  it("does not land while there is uncommitted work", () => {
    expect(branchHasLanded(pullRequest("Merged"), worktree({ changed_files_count: 2 }))).toBe(
      false,
    );
  });

  /// Every missing input has to fall on the "keep offering" side — hiding the action is the
  /// direction that leaves a user with no way to ship.
  it("does not land on anything it cannot read", () => {
    expect(branchHasLanded(null, worktree())).toBe(false);
    expect(branchHasLanded(undefined, worktree())).toBe(false);
    expect(branchHasLanded(pullRequest("Merged"), null)).toBe(false);
    expect(branchHasLanded(pullRequest("Merged"), undefined)).toBe(false);
    expect(branchHasLanded(pullRequest("Merged", null), worktree())).toBe(false);
    expect(branchHasLanded(pullRequest("Merged"), worktree({ head_sha: "" }))).toBe(false);
  });
});
