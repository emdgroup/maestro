import { describe, it, expect } from "vitest";
import { folderName, pathIsWithin, relativeAge, worktreeUsage } from "./worktree-usage";
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

describe("worktreeUsage", () => {
  it("splits sessions in this worktree into linkable agents and a shell count", () => {
    const usage = worktreeUsage(worktree({ task_id: 4, task_name: "Do the thing" }), [
      session({ session_key: 1 }),
      session({ session_key: 2 }),
      session({ session_key: 3, execution_mode: "pty" }),
      session({ session_key: 4, cwd: "/repo/.maestro/worktrees/session-31" }),
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
