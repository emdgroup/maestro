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
const found = vi.hoisted(() => ({ current: null as BranchPullRequestInfo | null }));
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
  // The session's only network question, asked by branch. `lookupEnabled` is what the gate tests
  // read: it is the single condition standing between an off-screen session and a forge request.
  useBranchPullRequest: (_p: unknown, _branch: string | null, enabled: boolean) => {
    lookupEnabled.current = enabled;
    return { data: enabled ? found.current : undefined };
  },
}));

const { useSessionShipState } = await import("./useSessionShipState");
const { deriveCi } = await import("./shipActions");

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
    last_commit_subject: null,
    detached_at: null,
    head_sha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
    upstream_gone: false,
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
    forge_supports_pull_request_list: true,
    forge_checks_out_fork_pull_requests: true,
    forge_finds_pull_request_by_branch: true,
    forge_searches_pull_requests: true,
    forge_enumerates_checks: true,
    applied: false,
    ...overrides,
  };
}

/** The whole card in one answer, which is what `fetch_branch_pull_request` returns. */
function branchPullRequest(overrides: Partial<BranchPullRequestInfo> = {}): BranchPullRequestInfo {
  return {
    number: 164,
    url: "https://github.com/emdgroup/maestro/pull/164",
    state: "Open",
    title: "Notify when an agent finishes",
    base_branch: "main",
    head_branch: "maestro/great-lynx-58",
    head_sha: "deadbeef",
    created_at: "2026-09-01T10:00:00Z",
    commits: 2,
    changed_files: 22,
    additions: 1487,
    deletions: 18,
    mergeable: true,
    checks: [],
    ...overrides,
  };
}

type ShipArgs = { taskId?: number | null; isProcessing?: boolean; visible?: boolean };

function ship(args?: ShipArgs) {
  return renderHook(() =>
    useSessionShipState(
      58,
      args?.taskId ?? null,
      args?.isProcessing ?? false,
      "C:/repo",
      args?.visible ?? true,
    ),
  ).result.current;
}

describe("useSessionShipState", () => {
  beforeEach(() => {
    worktrees.current = [worktree()];
    hosting.current = readyHosting();
    sessions.current = [];
    found.current = null;
    lookupEnabled.current = false;
  });

  /// Every ACP session's panel stays mounted so its state survives navigation, so without a
  /// visibility gate each open session would ask the forge on its own timer for a card nobody is
  /// looking at. Exactly one session is ever visible, which is what makes a per-branch question
  /// affordable at all.
  it("asks the forge nothing while the card is off screen", () => {
    found.current = branchPullRequest();

    ship({ visible: false });
    expect(lookupEnabled.current).toBe(false);

    ship({ visible: true });
    expect(lookupEnabled.current).toBe(true);
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

  /// The lookup gate used to be `ahead_behind != null`, so a merge deleting the head branch stopped
  /// the card asking the forge anything at all: the `Merged` badge beside it was cache from before
  /// the prune and vanished on the next restart, leaving only the wrong button. `upstream_gone` is
  /// what says the branch *was* pushed and is worth a question — while a branch that genuinely
  /// never was still costs no request, which is the point of the gate.
  it("still asks the forge once the upstream was deleted under the branch", () => {
    worktrees.current = [worktree({ ahead_behind: null, upstream_gone: true })];
    ship();
    expect(lookupEnabled.current).toBe(true);

    worktrees.current = [worktree({ ahead_behind: null, upstream_gone: false })];
    ship();
    expect(lookupEnabled.current).toBe(false);
  });

  /// The reported bug: #336 merged, GitHub deleted the head branch, `@{u}` stopped resolving, and
  /// the Changes card read that as "never pushed" and offered to commit and push work already in
  /// main — right beside a card reading `Merged #336`.
  it("offers nothing once the branch's work has merged at this commit", () => {
    worktrees.current = [
      worktree({ ahead_behind: null, upstream_gone: true, head_sha: "landed-sha" }),
    ];
    found.current = branchPullRequest({ state: "Merged", head_sha: "landed-sha" });

    const state = ship();
    expect(state.action).toBe("none");
    expect(state.blocker).toBeNull();
  });

  /// The head-sha equality is what keeps the rule a refinement rather than "a merged pull request
  /// silences the card forever". A commit made after the merge is new work, and pushing it does
  /// need `--set-upstream` to recreate the branch the forge deleted.
  it("offers again once the branch has moved past the merged commit", () => {
    worktrees.current = [
      worktree({ ahead_behind: null, upstream_gone: true, head_sha: "moved-on-sha" }),
    ];
    found.current = branchPullRequest({ state: "Merged", head_sha: "landed-sha" });

    expect(ship().action).toBe("commit-push");
  });

  /// The one gate that crosses the network. A forge with no branch-lookup arm would return an
  /// error every thirty seconds for the life of the session.
  ///
  /// Gated on the branch lookup rather than the project list, and the two are genuinely different
  /// capabilities: the list answers one *page* of a project which may have thousands of open pull
  /// requests, so a branch missing from it is indistinguishable from a branch that has none.
  it("does not poll the forge when it cannot answer", () => {
    hosting.current = readyHosting({ forge_finds_pull_request_by_branch: false });
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
    found.current = branchPullRequest();
    expect(ship().blocker).toBe("pull-request-open");
  });

  /// The lookup asks for every state, not just open ones. A session opened on a branch whose pull
  /// request already merged should say so — showing nothing would read as "never had one", and the
  /// confirmation that the work landed is the thing the user came back to see.
  it("shows a pull request that has already landed", () => {
    found.current = branchPullRequest({ state: "Merged" });
    const state = ship();
    expect(state.pullRequest?.number).toBe(164);
    expect(state.pullRequest?.state).toBe("Merged");
    // A merged one is history, not a reason to refuse the next.
    expect(state.blocker).toBeNull();
  });

  /// One answer, one moment. The title, the counts and the checks used to come from three queries
  /// on three timers, which is how the card's header could describe a different poll than its rows.
  it("renders the whole card from the single answer", () => {
    found.current = branchPullRequest({
      title: "Notify when an agent finishes work",
      additions: 1487,
      changed_files: 22,
      mergeable: true,
    });

    const state = ship();
    expect(state.pullRequest?.title).toBe("Notify when an agent finishes work");
    expect(state.pullRequest?.additions).toBe(1487);
    expect(state.pullRequest?.changed_files).toBe(22);
    expect(state.pullRequest?.mergeable).toBe(true);
  });

  /// The card gates its entire checks block on `ci`, and a pull request whose checks have not
  /// queued yet has no verdict to carry. Deriving it from anything but the checks in this same
  /// answer is what left `checks` filled into a block that never rendered.
  it("derives the verdict from the checks in the same answer", () => {
    found.current = branchPullRequest({ checks: [] });
    expect(ship().pullRequest?.ci).toBeNull();

    found.current = branchPullRequest({ checks: [{ name: "build", status: "Running" }] });
    expect(ship().pullRequest?.ci).toBe("Pending");
  });

  /// The verdict, the rows and the fix prompt are three readings of one answer. Sourcing them
  /// separately let the ring show a finished matrix under a header still saying "Pending", and
  /// seeded the agent prompt with a check that had since gone green.
  it("re-derives the verdict and the failing names from the checks it renders", () => {
    const checks = [
      { name: "build (windows)", status: "Failed" as const },
      { name: "vitest", status: "Passed" as const },
    ];
    found.current = branchPullRequest({ checks });

    const state = ship();
    expect(state.pullRequest?.ci).toBe("Failing");
    expect(state.pullRequest?.failing_checks).toEqual(["build (windows)"]);
    expect(state.pullRequest?.checks).toBe(checks);
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

  /// A branch level with its base has no commit of its own, so the subject git read from HEAD is
  /// the base branch's last commit — someone else's merge, offered as the title of work that has
  /// not been written yet.
  it("offers no commit subject while the branch is level with its base", () => {
    const subject = "Bump the schema to v28";

    worktrees.current = [worktree({ commit_count: 0, last_commit_subject: subject })];
    expect(ship().lastCommitSubject).toBeNull();

    worktrees.current = [worktree({ commit_count: 1, last_commit_subject: subject })];
    expect(ship().lastCommitSubject).toBe(subject);
  });

  /// `null` is not zero: it means there was no base branch to count against, which says nothing
  /// about whether the branch has commits of its own. An orphan worktree always lands there.
  it("keeps the subject when the commit count is unknown", () => {
    const subject = "Bump the schema to v28";
    worktrees.current = [worktree({ commit_count: null, last_commit_subject: subject })];
    expect(ship().lastCommitSubject).toBe(subject);
  });

  /// A detached worktree has no branch to open a pull request from, whatever name the row kept.
  it("has no branch when the worktree is detached", () => {
    worktrees.current = [worktree({ detached_at: "a1b2c3d" })];
    expect(ship().branch).toBeNull();
  });
});

describe("deriveCi", () => {
  /// Must stay a mirror of Rust's `summarise_checks` + `ci_summary`. The two run over the same
  /// forge answer, and the sweep that starts a CI-fix agent reads the Rust one — a card calling a
  /// pull request `Failing` that the backend calls `Pending` is two truths about one commit.
  it("ranks a running matrix above a failure within it", () => {
    expect(
      deriveCi([
        { name: "build (windows)", status: "Failed" },
        { name: "e2e", status: "Running" },
      ]).ci,
    ).toBe("Pending");
  });

  /// A failure only counts once nothing is still going, and the names are what the fix prompt
  /// sends to the agent instead of making it go and look.
  it("names the failures once the matrix has settled", () => {
    const { ci, failingChecks } = deriveCi([
      { name: "build (windows)", status: "Failed" },
      { name: "cargo test", status: "Failed" },
      { name: "vitest", status: "Passed" },
    ]);
    expect(ci).toBe("Failing");
    expect(failingChecks).toEqual(["build (windows)", "cargo test"]);
  });

  it("is passing when every check has passed", () => {
    expect(deriveCi([{ name: "vitest", status: "Passed" }])).toEqual({
      ci: "Passing",
      failingChecks: [],
    });
  });

  /// Gitea and Forgejo enumerate nothing, and a ring drawn at zero of zero would claim a run that
  /// does not exist. `null` is what the card reads as "drop the checks block".
  it("has no verdict at all for a forge that enumerates nothing", () => {
    expect(deriveCi([])).toEqual({ ci: null, failingChecks: [] });
  });
});
