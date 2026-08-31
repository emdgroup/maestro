import { describe, it, expect } from "vitest";
import { checkoutTargetBranch, findBranchConflict } from "./branch-conflict";
import type { WorktreeWithStatus } from "@/types/bindings";

const REPO = "/repo";

function worktree(overrides: Partial<WorktreeWithStatus> = {}): WorktreeWithStatus {
  return {
    id: 1,
    path: "/repo/.maestro/worktrees/session-1",
    branch_name: "feature/payments",
    base_branch: "main",
    task_id: null,
    task_name: null,
    created_at: null,
    last_activity_at: null,
    changed_files_count: 0,
    commit_count: null,
    detached_at: null,
    diff_stat: null,
    ahead_behind: null,
    is_zombie: false,
    is_orphan: false,
    ...overrides,
  } as WorktreeWithStatus;
}

describe("findBranchConflict", () => {
  it("finds the worktree holding the branch", () => {
    const conflict = findBranchConflict("feature/payments", [worktree()], REPO);
    expect(conflict).toEqual({ kind: "worktree", worktree: expect.objectContaining({ id: 1 }) });
  });

  it("reports nothing for a branch no worktree is on", () => {
    expect(findBranchConflict("feature/other", [worktree()], REPO)).toBeNull();
  });

  /// git refuses the branch its main worktree is on just as readily, but the recovery differs:
  /// the root is not reusable as a workspace, so the caller offers `RepositoryDirectory` instead.
  it("distinguishes the repository directory from a worktree", () => {
    const conflict = findBranchConflict(
      "main",
      [worktree({ id: 2, path: REPO, branch_name: "main" })],
      REPO,
    );
    expect(conflict).toEqual({
      kind: "repositoryDirectory",
      worktree: expect.objectContaining({ id: 2 }),
    });
  });

  it("compares paths across separators and trailing slashes", () => {
    const conflict = findBranchConflict(
      "main",
      [worktree({ path: "C:\\repo\\", branch_name: "main" })],
      "C:/repo",
    );
    expect(conflict?.kind).toBe("repositoryDirectory");
  });

  /// The one rule most likely to regress. A detached worktree keeps the branch name it was created
  /// on, but is checked out on nothing, so it blocks nothing.
  it("ignores a detached worktree even when its recorded branch matches", () => {
    const detached = worktree({ detached_at: "a1b2c3d" });
    expect(findBranchConflict("feature/payments", [detached], REPO)).toBeNull();
  });

  it("still finds a real holder alongside a detached decoy", () => {
    const conflict = findBranchConflict(
      "feature/payments",
      [
        worktree({ id: 1, detached_at: "a1b2c3d" }),
        worktree({ id: 2, path: "/repo/.maestro/worktrees/session-2" }),
      ],
      REPO,
    );
    expect(conflict?.worktree.id).toBe(2);
  });

  it("reports nothing for an empty branch", () => {
    expect(findBranchConflict("", [worktree({ branch_name: "" })], REPO)).toBeNull();
  });

  /// Checking out `origin/main` lands the worktree on a local `main`, so the repository directory
  /// sitting on `main` blocks it. Matching the qualified name against `branch_name` — which is
  /// always local — would report no conflict and then fail inside git.
  it("resolves a remote branch to the local one it would check out", () => {
    const conflict = findBranchConflict(
      "origin/main",
      [worktree({ id: 2, path: REPO, branch_name: "main" })],
      REPO,
      { local: ["main"], remote: ["origin/main"] },
    );
    expect(conflict).toEqual({
      kind: "repositoryDirectory",
      worktree: expect.objectContaining({ id: 2 }),
    });
  });

  /// A local branch really can be called `origin/foo` — it lives at `refs/heads/origin/foo`. The
  /// Local tab offers it under that name, so it must not be stripped down to `foo`.
  it("prefers a local branch whose own name looks remote-qualified", () => {
    const holder = worktree({ id: 3, branch_name: "origin/main" });
    const branches = { local: ["origin/main"], remote: ["origin/main"] };

    expect(findBranchConflict("origin/main", [holder], REPO, branches)?.worktree.id).toBe(3);
    // Without a local branch by that name it resolves to `main`, which nothing here holds.
    expect(
      findBranchConflict("origin/main", [holder], REPO, { local: [], remote: ["origin/main"] }),
    ).toBeNull();
  });
});

describe("checkoutTargetBranch", () => {
  const branches = {
    local: ["main", "feature/payments"],
    remote: ["origin/main", "origin/chore/registry", "fork/experiment"],
  };

  it("strips the remote segment from a name the remote list holds", () => {
    expect(checkoutTargetBranch("origin/main", branches)).toBe("main");
    // Slashes past the first belong to the branch name.
    expect(checkoutTargetBranch("origin/chore/registry", branches)).toBe("chore/registry");
    expect(checkoutTargetBranch("fork/experiment", branches)).toBe("experiment");
  });

  /// The reason membership decides this rather than the presence of a slash: plenty of local
  /// branches are namespaced, and stripping one would point the conflict check at the wrong branch.
  it("leaves a slashed local branch untouched", () => {
    expect(checkoutTargetBranch("feature/payments", branches)).toBe("feature/payments");
    expect(checkoutTargetBranch("maestro/kind-canyon-49", branches)).toBe("maestro/kind-canyon-49");
    expect(checkoutTargetBranch("main", branches)).toBe("main");
    expect(checkoutTargetBranch("", branches)).toBe("");
  });
});
