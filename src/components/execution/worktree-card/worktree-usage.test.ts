import { describe, it, expect } from "vitest";
import {
  folderName,
  pathIsWithin,
  relativeAge,
  relativeWorktreePath,
  sessionsByWorktree,
  worktreeUsage,
} from "./worktree-usage";
import type { ActiveSessionInfo, WorktreeWithStatus } from "@/types/bindings";

function worktree(overrides: Partial<WorktreeWithStatus> = {}): WorktreeWithStatus {
  return {
    id: 1,
    project_id: 1,
    task_id: null,
    path: "/repo/.maestro/worktrees/session-3",
    branch_name: "b",
    base_branch: "main",
    created_at: null,
    task_name: null,
    changed_files_count: 0,
    diff_stat: null,
    ahead_behind: null,
    commit_count: null,
    last_activity_at: null,
    detached_at: null,
    is_zombie: false,
    is_orphan: false,
    ...overrides,
  };
}

function session(overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    session_key: 1,
    session_name: null,
    agent_id: "claude",
    execution_mode: "acp",
    started_at: "2026-08-29T00:00:00Z",
    task_id: null,
    task_name: null,
    branch_name: null,
    acp_session_id: null,
    cwd: "/repo/.maestro/worktrees/session-3",
    supports_session_list: false,
    supports_session_load: false,
    supports_session_close: false,
    supports_session_delete: false,
    project_id: 1,
    ...overrides,
  };
}

describe("pathIsWithin", () => {
  it("matches the worktree itself and anything under it", () => {
    expect(pathIsWithin("/repo/wt", "/repo/wt")).toBe(true);
    expect(pathIsWithin("/repo/wt/src/deep", "/repo/wt")).toBe(true);
    expect(pathIsWithin("/repo/wt/", "/repo/wt")).toBe(true);
  });

  /**
   * The reason this is not a plain `startsWith`. Maestro names worktrees `session-<id>`, so a
   * two-digit id is always a prefix of some one-digit sibling's neighbourhood.
   */
  it("does not let a shorter name swallow a longer sibling", () => {
    expect(pathIsWithin("/repo/wt/session-31", "/repo/wt/session-3")).toBe(false);
  });

  // A worktree path is assembled with forward slashes; a session records the cwd it was given,
  // which on Windows arrives with backslashes.
  it("compares across separator styles", () => {
    expect(pathIsWithin("C:\\repo\\wt\\src", "C:/repo/wt")).toBe(true);
  });

  it("rejects an unrelated path", () => {
    expect(pathIsWithin("/elsewhere", "/repo/wt")).toBe(false);
  });
});

describe("sessionsByWorktree", () => {
  const root = worktree({ id: 1, path: "/repo", branch_name: "main", base_branch: null });
  const child = worktree({ id: 2, path: "/repo/.maestro/worktrees/session-3" });

  /**
   * The repository directory card used to claim every agent in the project, because Maestro's
   * worktrees live under `.maestro/worktrees/` and so are inside the root's path by definition.
   */
  it("credits a session to the innermost worktree containing it, not to every ancestor", () => {
    const byPath = sessionsByWorktree(
      [root, child],
      [session({ session_key: 1, cwd: "/repo/.maestro/worktrees/session-3/src" })],
    );

    expect(byPath.get("/repo/.maestro/worktrees/session-3")?.map((s) => s.session_key)).toEqual([
      1,
    ]);
    expect(byPath.get("/repo")).toEqual([]);
  });

  it("still credits a session running in the repository directory itself", () => {
    const byPath = sessionsByWorktree([root, child], [session({ session_key: 7, cwd: "/repo" })]);

    expect(byPath.get("/repo")?.map((s) => s.session_key)).toEqual([7]);
    expect(byPath.get("/repo/.maestro/worktrees/session-3")).toEqual([]);
  });

  // A sibling whose name is a prefix of this one's is not an ancestor of it.
  it("does not let a shorter sibling name swallow a longer one", () => {
    const sibling = worktree({ id: 3, path: "/repo/.maestro/worktrees/session-31" });
    const byPath = sessionsByWorktree(
      [child, sibling],
      [session({ cwd: "/repo/.maestro/worktrees/session-31" })],
    );

    expect(byPath.get("/repo/.maestro/worktrees/session-3")).toEqual([]);
    expect(byPath.get("/repo/.maestro/worktrees/session-31")).toHaveLength(1);
  });

  it("drops a session running outside every worktree", () => {
    const byPath = sessionsByWorktree([root], [session({ cwd: "/elsewhere" })]);

    expect(byPath.get("/repo")).toEqual([]);
  });
});

describe("worktreeUsage", () => {
  it("splits the sessions in this worktree into linkable agents and a shell count", () => {
    const usage = worktreeUsage(worktree({ task_id: 4, task_name: "Do the thing" }), [
      session({ session_key: 1 }),
      session({ session_key: 2 }),
      session({ session_key: 3, execution_mode: "pty" }),
    ]);

    expect(usage.task).toEqual({ id: 4, name: "Do the thing" });
    expect(usage.agents.map((a) => a.session_key)).toEqual([1, 2]);
    expect(usage.shellCount).toBe(1);
  });

  // The row survives its task being renamed to nothing; the card still has to link somewhere.
  it("names a task with no title by its id", () => {
    expect(worktreeUsage(worktree({ task_id: 9 }), []).task).toEqual({ id: 9, name: "Task 9" });
  });
});

describe("relativeAge", () => {
  const now = Date.parse("2026-08-29T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  /**
   * `formatDistanceToNow` renders anything under a minute as "less than a minute ago" — four words
   * for the least informative case, and the label the card used to show.
   */
  it("floors at one minute", () => {
    expect(relativeAge(ago(2_000), now)).toBe("1 min");
    expect(relativeAge(ago(59_000), now)).toBe("1 min");
  });

  it("steps up through the units", () => {
    expect(relativeAge(ago(5 * 60_000), now)).toBe("5 min");
    expect(relativeAge(ago(3 * 3_600_000), now)).toBe("3 h");
    expect(relativeAge(ago(2 * 86_400_000), now)).toBe("2 d");
    expect(relativeAge(ago(21 * 86_400_000), now)).toBe("3 w");
  });

  // Clock skew between a remote worktree's host and this one must not read as "in 3 minutes".
  it("floors a timestamp from the future rather than counting forward", () => {
    expect(relativeAge(ago(-5 * 60_000), now)).toBe("1 min");
  });

  it("returns nothing it cannot parse", () => {
    expect(relativeAge(null, now)).toBeNull();
    expect(relativeAge("not a date", now)).toBeNull();
  });
});

describe("folderName", () => {
  it("takes the last segment, whatever the separators", () => {
    expect(folderName("/repo/.maestro/worktrees/session-3")).toBe("session-3");
    expect(folderName("C:\\repo\\wt\\")).toBe("wt");
    expect(folderName("/repo")).toBe("repo");
  });
});

describe("relativeWorktreePath", () => {
  it("says where the worktree sits, relative to the repository", () => {
    expect(relativeWorktreePath("/repo/.maestro/worktrees/session-31", "/repo")).toBe(
      ".maestro/worktrees/session-31",
    );
  });

  it("normalises native separators", () => {
    expect(relativeWorktreePath("C:\\repo\\.maestro\\worktrees\\session-3", "C:/repo")).toBe(
      ".maestro/worktrees/session-3",
    );
  });

  // The repository root has no relative path to give.
  it("names the repository root by its folder", () => {
    expect(relativeWorktreePath("/repo", "/repo")).toBe("repo");
    expect(relativeWorktreePath("/repo/", "/repo")).toBe("repo");
  });

  // Git permits a worktree anywhere; inventing a relative path for one would be a lie.
  it("keeps the full path for a worktree outside the repository", () => {
    expect(relativeWorktreePath("/elsewhere/hotfix", "/repo")).toBe("/elsewhere/hotfix");
  });

  // A sibling directory sharing the root's prefix is not inside it.
  it("does not treat a prefix match as containment", () => {
    expect(relativeWorktreePath("/repo-backup/wt", "/repo")).toBe("/repo-backup/wt");
  });
});
