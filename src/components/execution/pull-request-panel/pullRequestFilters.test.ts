import { describe, it, expect } from "vitest";
import type { ActiveSessionInfo, ProjectPullRequest, WorktreeWithStatus } from "@/types/bindings";
import {
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
    updated_at: "2026-09-04T11:00:00Z",
    from_fork: false,
    detail: null,
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
    const [entry] = pullRequestEntries([pullRequest()], [wt], sessions, "origin", true);

    expect(entry.worktree).toBe(wt);
    expect(entry.action).toEqual({
      kind: "open-session",
      sessionKey: 58,
      sessionLabel: "reviewer",
    });
  });

  it("offers the existing worktree when nothing is running in it", () => {
    const wt = worktree();
    const [entry] = pullRequestEntries([pullRequest()], [wt], noSessions, "origin", true);
    expect(entry.action).toEqual({ kind: "reuse-worktree", worktree: wt });
  });

  /// The remote-tracking ref, not the bare name: `create_worktree` resolves `origin/x` into a local
  /// `x` that tracks it, where a bare `x` would need a local branch that does not exist yet.
  it("offers a new worktree from the remote ref when there is none", () => {
    const [entry] = pullRequestEntries([pullRequest()], [], noSessions, "origin", true);
    expect(entry.worktree).toBeNull();
    expect(entry.action).toEqual({
      kind: "new-worktree",
      baseBranch: "origin/maestro/great-lynx-58",
      pullRequestNumber: null,
    });
  });

  /// A project whose remote is not called `origin` would otherwise be handed a ref that does not
  /// resolve, and the worktree creation would fail well after the user committed to it.
  it("builds the ref from the project's own remote", () => {
    const [entry] = pullRequestEntries([pullRequest()], [], noSessions, "upstream", true);
    expect(entry.action).toEqual({
      kind: "new-worktree",
      baseBranch: "upstream/maestro/great-lynx-58",
      pullRequestNumber: null,
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
      true,
    );
    expect(entry.worktree).toBeNull();
    expect(entry.action.kind).toBe("new-worktree");
  });

  /// A terminal is a shell the user opened, not a conversation to resume. Treating it as one would
  /// navigate them to a prompt instead of offering to start the agent they came here for.
  it("ignores a terminal when deciding whether a session exists", () => {
    const wt = worktree();
    const sessions = new Map([[wt.path, [session({ execution_mode: "pty" })]]]);
    const [entry] = pullRequestEntries([pullRequest()], [wt], sessions, "origin", true);
    expect(entry.action.kind).toBe("reuse-worktree");
  });

  /// A fork's head branch is in a repository this project has no remote for, so `origin/<head>` is
  /// not it. The head comes from the ref the forge publishes instead, and the number goes with it.
  it("checks a fork's pull request out through the forge rather than the remote", () => {
    const fork = pullRequest({ number: 412, head_branch: "patch-1", from_fork: true });
    const [entry] = pullRequestEntries([fork], [], noSessions, "origin", true);

    expect(entry.worktree).toBeNull();
    expect(entry.action).toEqual({
      kind: "new-worktree",
      // The branch it merges *into*, not something to check out: it is what the row records and
      // what the card counts this pull request's commits against.
      baseBranch: "main",
      pullRequestNumber: 412,
    });
  });

  /// The bug this whole path exists for. `origin/patch-1` may well resolve — to an unrelated branch
  /// of this repository that happens to share the fork's name — and checking that out succeeds
  /// silently, leaving a session reviewing code that has nothing to do with the pull request.
  /// `patch-1` and `fix-typo` are the names GitHub's own web editor generates.
  it("never offers a fork's row the remote branch that shares its name", () => {
    const fork = pullRequest({ number: 412, head_branch: "patch-1", from_fork: true });
    const ours = worktree({ id: 9, branch_name: "patch-1", path: "C:/repo/.maestro/worktrees/x" });

    const [entry] = pullRequestEntries([fork], [ours], noSessions, "origin", true);

    // Not matched to our own `patch-1` worktree, and not offered `origin/patch-1` either.
    expect(entry.worktree).toBeNull();
    expect(entry.action).toEqual({
      kind: "new-worktree",
      baseBranch: "main",
      pullRequestNumber: 412,
    });
  });

  /// Matched on the branch the checkout actually lands on, or the panel would offer to create a
  /// second worktree for a pull request that already has one.
  it("matches a fork's worktree by its pull request branch", () => {
    const fork = pullRequest({ number: 412, head_branch: "patch-1", from_fork: true });
    const wt = worktree({
      id: 9,
      branch_name: "pr-412",
      path: "C:/repo/.maestro/worktrees/pr-412",
    });

    const [entry] = pullRequestEntries([fork], [wt], noSessions, "origin", true);
    expect(entry.action).toEqual({ kind: "reuse-worktree", worktree: wt });

    const sessions = new Map([[wt.path, [session()]]]);
    const [running] = pullRequestEntries([fork], [wt], sessions, "origin", true);
    expect(running.action).toMatchObject({ kind: "open-session", sessionKey: 58 });
  });

  /// Azure DevOps publishes only the merge commit it would produce, not the branch under review.
  /// Saying so beats a button that fails once pressed — and beats checking out the wrong thing.
  it("withholds the action on a forge that publishes no head ref", () => {
    const fork = pullRequest({ number: 412, head_branch: "patch-1", from_fork: true });
    const [entry] = pullRequestEntries([fork], [], noSessions, "origin", false);

    expect(entry.action.kind).toBe("unsupported");
  });

  /// The same forge still checks out its own branches: only the fork rows lose the action.
  it("still offers the remote branch for a same-repository row on that forge", () => {
    const [entry] = pullRequestEntries([pullRequest()], [], noSessions, "origin", false);
    expect(entry.action).toEqual({
      kind: "new-worktree",
      baseBranch: "origin/maestro/great-lynx-58",
      pullRequestNumber: null,
    });
  });

  it("names an unnamed session by its key", () => {
    const wt = worktree();
    const sessions = new Map([[wt.path, [session({ session_name: null, task_name: null })]]]);
    const [entry] = pullRequestEntries([pullRequest()], [wt], sessions, "origin", true);
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
    action: {
      kind: "new-worktree",
      baseBranch: "origin/maestro/wise-forest-51",
      pullRequestNumber: null,
    },
  };
  const entries = [linked, unlinked];

  /// The one filter left, and the only one that could stay. Search went to the forge, because
  /// matching the thirty rows on screen out of a project's eleven thousand finds almost nothing and
  /// reads as an empty repository; the CI filter had the same problem and no server-side answer on
  /// any of the six forges. This one needs nothing from the forge at all — it is a join against the
  /// user's own worktrees, so it means the same thing on every provider.
  it("splits on whether a worktree exists", () => {
    expect(filterPullRequests(entries, "All")).toHaveLength(2);
    expect(filterPullRequests(entries, "WithWorktree")).toEqual([linked]);
    expect(filterPullRequests(entries, "Others")).toEqual([unlinked]);
  });

  /// A detached worktree is not a match however its row is labelled, so a page of them filters to
  /// nothing under "with worktree" rather than to everything.
  it("keeps an empty page empty", () => {
    expect(filterPullRequests([], "WithWorktree")).toEqual([]);
    expect(filterPullRequests([], "All")).toEqual([]);
  });
});
