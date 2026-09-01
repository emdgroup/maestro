import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type {
  ActiveSessionInfo,
  BranchPullRequestInfo,
  CodeHostingStatus,
  WorktreeWithStatus,
} from "@/types/bindings";

const worktrees = vi.hoisted(() => ({ current: [] as WorktreeWithStatus[] }));
const hosting = vi.hoisted(() => ({ current: null as CodeHostingStatus | null }));
const sessions = vi.hoisted(() => ({ current: [] as ActiveSessionInfo[] }));
const pullRequest = vi.hoisted(() => ({ current: null as BranchPullRequestInfo | null }));
const lookupEnabled = vi.hoisted(() => ({ current: false }));

vi.mock("@/services/execution.service", () => ({
  useAcpSessionMeta: () => ({
    data: { cwd: "C:/repo/.maestro/worktrees/session-58", project_id: 1, session_start_sha: null },
  }),
  useActiveSessionsQuery: () => ({ data: sessions.current }),
}));

vi.mock("@/services/worktree.service", () => ({
  useWorktreesQuery: () => ({ data: worktrees.current }),
}));

vi.mock("@/services/integration.service", () => ({
  useCodeHostingStatus: () => ({ data: hosting.current }),
  useBranchPullRequest: (_p: unknown, _b: unknown, enabled: boolean) => {
    lookupEnabled.current = enabled;
    return { data: enabled ? pullRequest.current : null };
  },
}));

const { useSessionShipState } = await import("./useSessionShipState");

function worktree(overrides: Partial<WorktreeWithStatus> = {}): WorktreeWithStatus {
  return {
    id: 7,
    project_id: 1,
    task_id: null,
    branch_name: "maestro/great-lynx-58",
    // Backslashes and a capital drive letter: what Windows actually hands us, against the
    // forward-slash path the Rust side builds.
    path: "C:\\repo\\.maestro\\worktrees\\session-58",
    changed_files_count: 0,
    created_at: null,
    task_name: null,
    is_zombie: false,
    is_orphan: false,
    diff_stat: null,
    base_branch: "origin/main",
    ahead_behind: { ahead: 0, behind: 0 },
    commit_count: 2,
    last_activity_at: null,
    detached_at: null,
    ...overrides,
  };
}

function readyHosting(overrides: Partial<CodeHostingStatus> = {}): CodeHostingStatus {
  return {
    rung: "Ready",
    landing_mode: "Merge",
    remote: "origin",
    remote_url: "https://github.com/emdgroup/maestro.git",
    config: {
      provider: "github",
      host: "github.com",
      owner: "emdgroup",
      repo: "maestro",
      project_path: "emdgroup/maestro",
    },
    forge_supports_pull_requests: true,
    forge_supports_branch_lookup: true,
    applied: false,
    ...overrides,
  };
}

function ship(args?: { taskId?: number | null; isProcessing?: boolean }) {
  return renderHook(() =>
    useSessionShipState(58, args?.taskId ?? null, args?.isProcessing ?? false, "C:/repo", true),
  ).result.current;
}

describe("useSessionShipState", () => {
  beforeEach(() => {
    worktrees.current = [worktree()];
    hosting.current = readyHosting();
    sessions.current = [];
    pullRequest.current = null;
    lookupEnabled.current = false;
  });

  /// The session's cwd and the worktree row disagree about slashes and drive-letter case on
  /// Windows. Matching them raw found no worktree, which silently disabled every gate.
  it("matches the session's worktree across path spelling differences", () => {
    expect(ship().branch).toBe("maestro/great-lynx-58");
  });

  /// The two actions answer opposite conditions, so exactly one is ever the offered one.
  it("offers commit-and-push only while there is something to push", () => {
    worktrees.current = [worktree({ changed_files_count: 4 })];
    expect(ship().action).toBe("commit-push");

    worktrees.current = [worktree({ ahead_behind: { ahead: 2, behind: 0 } })];
    expect(ship().action).toBe("commit-push");

    worktrees.current = [worktree()];
    expect(ship().action).toBe("open-pull-request");
  });

  /// A branch with no upstream has never been pushed, so every commit on it is unpushed — which
  /// `ahead: 0` would otherwise claim was level with a remote that does not exist.
  it("treats a branch with no upstream as unpushed", () => {
    worktrees.current = [worktree({ ahead_behind: null })];
    const state = ship();
    expect(state.action).toBe("commit-push");
    expect(lookupEnabled.current).toBe(false);
  });

  /// The lookup is the only gate that crosses the network. A forge with no branch-lookup arm would
  /// return an error every thirty seconds for the life of the session.
  it("does not poll the forge when it cannot answer", () => {
    hosting.current = readyHosting({ forge_supports_branch_lookup: false });
    ship();
    expect(lookupEnabled.current).toBe(false);

    hosting.current = readyHosting({ rung: "NotConnected" });
    ship();
    expect(lookupEnabled.current).toBe(false);

    hosting.current = readyHosting();
    ship();
    expect(lookupEnabled.current).toBe(true);
  });

  /// A task's pull request is the board's to open — opening one here would leave the task in a
  /// phase the reconcile sweep never looks at, so the card would never update again.
  it("refuses to open a pull request for a task's session", () => {
    expect(ship({ taskId: 42 }).blocker).toBe("task-owned");
    expect(ship({ taskId: null }).blocker).toBeNull();
  });

  /// Opening a second pull request for a branch that already has one is a forge error at best.
  it("blocks when the branch already has an open pull request", () => {
    const open: BranchPullRequestInfo = {
      number: 164,
      url: "https://github.com/emdgroup/maestro/pull/164",
      title: "Notify when an agent finishes",
      state: "Open",
      ci: "Failing",
      failing_checks: ["build"],
      checks: [{ name: "build", status: "Failed" }],
    };
    pullRequest.current = open;
    expect(ship().blocker).toBe("pull-request-open");

    // A merged one is history, not a reason to refuse the next.
    pullRequest.current = { ...open, state: "Merged" };
    expect(ship().blocker).toBeNull();
  });

  /// Acting on a branch an agent is still writing to is the race the idle check exists to stop.
  it("blocks both actions while the agent is mid-turn", () => {
    expect(ship({ isProcessing: true }).blocker).toBe("agent-busy");
  });

  /// Only sessions in this same directory can be writing to this branch; one elsewhere in the
  /// project is irrelevant and would make the warning meaningless if it counted.
  it("counts only the sessions sharing this workspace", () => {
    const base: ActiveSessionInfo = {
      session_key: 0,
      session_name: null,
      agent_id: null,
      execution_mode: "acp",
      started_at: "",
      task_id: null,
      task_name: null,
      branch_name: null,
      acp_session_id: null,
      cwd: "",
      supports_session_list: false,
      supports_session_load: false,
      supports_session_close: false,
      supports_session_delete: false,
      project_id: 1,
    };
    sessions.current = [
      { ...base, session_key: 58, cwd: "C:/repo/.maestro/worktrees/session-58" },
      {
        ...base,
        session_key: 59,
        session_name: "reviewer",
        cwd: "C:\\repo\\.maestro\\worktrees\\session-58",
      },
      {
        ...base,
        session_key: 60,
        session_name: "elsewhere",
        cwd: "C:/repo/.maestro/worktrees/session-12",
      },
    ];
    expect(ship().concurrentSessions).toEqual(["reviewer"]);
  });

  /// A detached worktree has no branch to open a pull request from, whatever name the row kept.
  it("has no branch when the worktree is detached", () => {
    worktrees.current = [worktree({ detached_at: "a1b2c3d" })];
    expect(ship().branch).toBeNull();
  });
});
