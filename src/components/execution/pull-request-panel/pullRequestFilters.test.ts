import { describe, it, expect } from "vitest";
import type { ActiveSessionInfo, ProjectPullRequest, WorktreeWithStatus } from "@/types/bindings";
import type { CiRollup, CiStatus } from "@/components/execution/worktree-card/pullRequestCi";

/** Only the rollup is filtered or counted on; the label is the chip's tooltip. */
function ciMap(...states: Array<[number, CiRollup]>): Map<number, CiStatus> {
  return new Map(states.map(([number, rollup]) => [number, { rollup, label: rollup }]));
}
import {
  countCiStates,
  filterPullRequests,
  pullRequestEntries,
  type PullRequestEntry,
} from "./pullRequestFilters";

function pullRequest(overrides: Partial<ProjectPullRequest> = {}): ProjectPullRequest {
  return {
    number: 310,
    url: "https://github.com/emdgroup/maestro/pull/310",
    title: "Ship pull requests from the session panel",
    head_branch: "maestro/great-lynx-58",
    base_branch: "main",
    created_at: "2026-09-02T09:00:00Z",
    head_sha: "deadbeef",
    ...overrides,
  };
}

function worktree(overrides: Partial<WorktreeWithStatus> = {}): WorktreeWithStatus {
  return {
    id: 7,
    project_id: 1,
    task_id: null,
    branch_name: "maestro/great-lynx-58",
    path: "C:/repo/.maestro/worktrees/session-58",
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
    last_commit_subject: null,
    detached_at: null,
    ...overrides,
  };
}

function session(overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    session_key: 58,
    session_name: "reviewer",
    agent_id: null,
    execution_mode: "acp",
    started_at: "",
    task_id: null,
    task_name: null,
    branch_name: null,
    acp_session_id: null,
    cwd: "C:/repo/.maestro/worktrees/session-58",
    supports_session_list: false,
    supports_session_load: false,
    supports_session_close: false,
    supports_session_delete: false,
    project_id: 1,
    ...overrides,
  };
}

const noSessions = new Map<string, ActiveSessionInfo[]>();

describe("pullRequestEntries", () => {
  /// The three actions are the whole feature: which one a row offers is decided here, and getting
  /// it wrong means a button whose label promises something other than what it does.
  it("offers the session when one is already running on the branch", () => {
    const wt = worktree();
    const sessions = new Map([[wt.path, [session()]]]);
    const [entry] = pullRequestEntries([pullRequest()], [wt], sessions, "origin");

    expect(entry.worktree).toBe(wt);
    expect(entry.action).toEqual({
      kind: "open-session",
      sessionKey: 58,
      sessionLabel: "reviewer",
    });
  });

  it("offers the existing worktree when nothing is running in it", () => {
    const wt = worktree();
    const [entry] = pullRequestEntries([pullRequest()], [wt], noSessions, "origin");
    expect(entry.action).toEqual({ kind: "reuse-worktree", worktree: wt });
  });

  /// The remote-tracking ref, not the bare name: `create_worktree` resolves `origin/x` into a local
  /// `x` that tracks it, where a bare `x` would need a local branch that does not exist yet.
  it("offers a new worktree from the remote ref when there is none", () => {
    const [entry] = pullRequestEntries([pullRequest()], [], noSessions, "origin");
    expect(entry.worktree).toBeNull();
    expect(entry.action).toEqual({
      kind: "new-worktree",
      baseBranch: "origin/maestro/great-lynx-58",
    });
  });

  /// A project whose remote is not called `origin` would otherwise be handed a ref that does not
  /// resolve, and the worktree creation would fail well after the user committed to it.
  it("builds the ref from the project's own remote", () => {
    const [entry] = pullRequestEntries([pullRequest()], [], noSessions, "upstream");
    expect(entry.action).toEqual({
      kind: "new-worktree",
      baseBranch: "upstream/maestro/great-lynx-58",
    });
  });

  /// A detached worktree keeps the branch name in its row but is not on that branch, so reusing it
  /// would drop a session somewhere other than the pull request's code.
  it("does not match a detached worktree", () => {
    const [entry] = pullRequestEntries(
      [pullRequest()],
      [worktree({ detached_at: "a1b2c3d" })],
      noSessions,
      "origin",
    );
    expect(entry.worktree).toBeNull();
    expect(entry.action.kind).toBe("new-worktree");
  });

  /// A terminal is a shell the user opened, not a conversation to resume. Treating it as one would
  /// navigate them to a prompt instead of offering to start the agent they came here for.
  it("ignores a terminal when deciding whether a session exists", () => {
    const wt = worktree();
    const sessions = new Map([[wt.path, [session({ execution_mode: "pty" })]]]);
    const [entry] = pullRequestEntries([pullRequest()], [wt], sessions, "origin");
    expect(entry.action.kind).toBe("reuse-worktree");
  });

  it("names an unnamed session by its key", () => {
    const wt = worktree();
    const sessions = new Map([[wt.path, [session({ session_name: null, task_name: null })]]]);
    const [entry] = pullRequestEntries([pullRequest()], [wt], sessions, "origin");
    expect(entry.action).toMatchObject({ sessionLabel: "Session 58" });
  });
});

describe("filterPullRequests", () => {
  const linked: PullRequestEntry = {
    pullRequest: pullRequest(),
    worktree: worktree(),
    action: { kind: "reuse-worktree", worktree: worktree() },
  };
  const unlinked: PullRequestEntry = {
    pullRequest: pullRequest({
      number: 305,
      title: "Stop the branch name field looking like a form",
      head_branch: "maestro/wise-forest-51",
    }),
    worktree: null,
    action: { kind: "new-worktree", baseBranch: "origin/maestro/wise-forest-51" },
  };
  const entries = [linked, unlinked];
  const ci = ciMap([310, "passing"], [305, "failing"]);
  const noCi = new Set<CiRollup>();

  it("splits on whether a worktree exists", () => {
    expect(filterPullRequests(entries, "", "All", noCi, ci)).toHaveLength(2);
    expect(filterPullRequests(entries, "", "WithWorktree", noCi, ci)).toEqual([linked]);
    expect(filterPullRequests(entries, "", "Others", noCi, ci)).toEqual([unlinked]);
  });

  /// An untouched CI header is an empty set, and a panel that showed nothing until the user clicked
  /// something would read as a failed query rather than as a filter.
  it("treats no CI selection as no CI filter", () => {
    expect(filterPullRequests(entries, "", "All", noCi, ci)).toHaveLength(2);
    expect(filterPullRequests(entries, "", "All", new Set<CiRollup>(["failing"]), ci)).toEqual([
      unlinked,
    ]);
  });

  /// A pull request whose checks have not arrived yet has no entry in the map at all, and must not
  /// silently satisfy a filter the user set for something else.
  it("counts a pull request with no answer as unknown", () => {
    expect(
      filterPullRequests(entries, "", "All", new Set<CiRollup>(["unknown"]), new Map()),
    ).toHaveLength(2);
    expect(
      filterPullRequests(entries, "", "All", new Set<CiRollup>(["passing"]), new Map()),
    ).toHaveLength(0);
  });

  it("searches the title, the branch and the bare number", () => {
    expect(filterPullRequests(entries, "form", "All", noCi, ci)).toEqual([unlinked]);
    expect(filterPullRequests(entries, "great-lynx", "All", noCi, ci)).toEqual([linked]);
    // Without the hash, because that is what a user types.
    expect(filterPullRequests(entries, "305", "All", noCi, ci)).toEqual([unlinked]);
    expect(filterPullRequests(entries, "SHIP", "All", noCi, ci)).toEqual([linked]);
  });

  it("combines the filters rather than choosing between them", () => {
    expect(filterPullRequests(entries, "form", "WithWorktree", noCi, ci)).toHaveLength(0);
  });
});

describe("countCiStates", () => {
  it("counts every state including the ones with no answer", () => {
    const entries = [
      {
        pullRequest: pullRequest({ number: 1 }),
        worktree: null,
        action: { kind: "new-worktree", baseBranch: "origin/a" },
      },
      {
        pullRequest: pullRequest({ number: 2 }),
        worktree: null,
        action: { kind: "new-worktree", baseBranch: "origin/b" },
      },
      {
        pullRequest: pullRequest({ number: 3 }),
        worktree: null,
        action: { kind: "new-worktree", baseBranch: "origin/c" },
      },
    ] as PullRequestEntry[];
    const ci = ciMap([1, "passing"], [2, "passing"], [3, "failing"]);
    expect(countCiStates(entries, ci)).toEqual({
      passing: 2,
      failing: 1,
      running: 0,
      unknown: 0,
    });
    expect(countCiStates(entries, new Map()).unknown).toBe(3);
  });
});
