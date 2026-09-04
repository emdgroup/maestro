import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type {
  ActiveSessionInfo,
  CodeHostingStatus,
  ProjectPullRequest,
  PullRequestCheckInfo,
  PullRequestDetailInfo,
  WorktreeWithStatus,
} from "@/types/bindings";

const worktrees = vi.hoisted(() => ({ current: [] as WorktreeWithStatus[] }));
const hosting = vi.hoisted(() => ({ current: null as CodeHostingStatus | null }));
const sessions = vi.hoisted(() => ({ current: [] as ActiveSessionInfo[] }));
const openPullRequests = vi.hoisted(() => ({ current: [] as ProjectPullRequest[] }));
const detail = vi.hoisted(() => ({ current: undefined as PullRequestDetailInfo | undefined }));
const refresh = vi.hoisted(() => vi.fn());
const lookupEnabled = vi.hoisted(() => ({ current: false }));
const detailEnabled = vi.hoisted(() => ({ current: false }));
const checksEnabled = vi.hoisted(() => ({ current: false }));
const liveChecks = vi.hoisted(() => ({ current: undefined as PullRequestCheckInfo[] | undefined }));

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
  // Detection: the project's open list, shared with the Worktrees view. `lookupEnabled` now tracks
  // whether the session asks for it at all, which is the gate that used to sit on the per-branch
  // lookup this replaced.
  useProjectPullRequests: (_p: unknown, enabled: boolean) => {
    lookupEnabled.current = enabled;
    return { data: enabled ? openPullRequests.current : [] };
  },
  usePullRequestDetail: (_p: unknown, _number: unknown, _headSha: unknown, enabled: boolean) => {
    detailEnabled.current = enabled;
    return { data: detail.current };
  },
  useRefreshProjectPullRequests: () => refresh,
  // The fast checks poll. Left empty by default, which keeps the gate tests about the gates rather
  // than about which query supplied the check list.
  //
  // Mirrors the real hook's own `enabled`, which is the visibility flag *and* a number to ask
  // about: the caller passes `null` for a pull request that is no longer open, and reading only the
  // flag here would let that stop being tested.
  useBranchPullRequestChecks: (
    _p: unknown,
    number: number | null,
    _headSha: unknown,
    enabled: boolean,
  ) => {
    checksEnabled.current = enabled && number != null;
    return { data: liveChecks.current };
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
    forge_enumerates_checks: true,
    applied: false,
    ...overrides,
  };
}

/** An entry as the project's open list carries it — thinner than the card's own shape. */
function listedPullRequest(overrides: Partial<ProjectPullRequest> = {}): ProjectPullRequest {
  return {
    number: 164,
    url: "https://github.com/emdgroup/maestro/pull/164",
    title: "Notify when an agent finishes",
    head_branch: "maestro/great-lynx-58",
    base_branch: "main",
    created_at: "2026-09-01T10:00:00Z",
    head_sha: "deadbeef",
    ...overrides,
  };
}

/** What the detail poll answers: the same pull request, read from the forge rather than the list. */
function detailInfo(overrides: Partial<PullRequestDetailInfo> = {}): PullRequestDetailInfo {
  return {
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
    ...overrides,
  };
}

type ShipArgs = { taskId?: number | null; isProcessing?: boolean; visible?: boolean };

/**
 * A fresh mount. Most of these tests are about what one render decides, so a new instance per call
 * keeps them independent — but anything about state the panel *keeps* needs `shipHook` below,
 * because a remount is exactly what the real panel never does.
 */
function ship(args?: ShipArgs) {
  return shipHook(args).result.current;
}

function shipHook(args?: ShipArgs) {
  return renderHook(() =>
    useSessionShipState(
      58,
      args?.taskId ?? null,
      args?.isProcessing ?? false,
      "C:/repo",
      args?.visible ?? true,
    ),
  );
}

describe("useSessionShipState", () => {
  beforeEach(() => {
    worktrees.current = [worktree()];
    hosting.current = readyHosting();
    sessions.current = [];
    openPullRequests.current = [];
    detail.current = undefined;
    refresh.mockClear();
    lookupEnabled.current = false;
    detailEnabled.current = false;
    checksEnabled.current = false;
    liveChecks.current = undefined;
  });

  /// Every ACP session's panel stays mounted so its state survives navigation, so without a
  /// visibility gate each open session asks the forge on its own timer for a card nobody is
  /// looking at — and the checks half of that is a request every five seconds.
  it("asks the forge nothing while the card is off screen", () => {
    // A detected pull request, so what is being tested is visibility rather than having nothing to
    // ask about.
    openPullRequests.current = [listedPullRequest()];

    ship({ visible: false });
    expect(lookupEnabled.current).toBe(false);
    expect(checksEnabled.current).toBe(false);
    expect(detailEnabled.current).toBe(false);

    ship({ visible: true });
    expect(lookupEnabled.current).toBe(true);
    expect(checksEnabled.current).toBe(true);
    expect(detailEnabled.current).toBe(true);
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
    hosting.current = readyHosting({ forge_supports_pull_request_list: false });
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
    openPullRequests.current = [listedPullRequest()];
    expect(ship().blocker).toBe("pull-request-open");
  });

  /// The list is open-only, so a merge is the entry disappearing from it. Reading that as "this
  /// branch never had one" would drop the card at the moment it should be confirming the work
  /// landed — and the session is the only place that still knows which number to ask about.
  it("keeps showing a pull request after it leaves the open list", () => {
    openPullRequests.current = [listedPullRequest()];
    const hook = shipHook();
    expect(hook.result.current.pullRequest?.state).toBe("Open");

    // The panel stays mounted for the life of the session, so this is a rerender rather than a
    // remount — which is the only way the number survives its entry leaving the list.
    openPullRequests.current = [];
    detail.current = detailInfo({ state: "Merged" });
    hook.rerender();

    expect(hook.result.current.pullRequest?.number).toBe(164);
    expect(hook.result.current.pullRequest?.state).toBe("Merged");
    expect(detailEnabled.current).toBe(true);
    // A merged one is history, not a reason to refuse the next.
    expect(hook.result.current.blocker).toBeNull();
  });

  /// The list carries a title it stops updating the moment the pull request leaves it, and never
  /// carried the counts at all. Both come from the detail poll, which is why it runs while the pull
  /// request is open rather than only once it has gone.
  it("takes the title and the counts from the detail poll, not the list", () => {
    openPullRequests.current = [listedPullRequest({ title: "Notify when an agent finishes" })];
    detail.current = detailInfo({ title: "Notify when an agent finishes work", additions: 1487 });

    const state = ship();
    expect(detailEnabled.current).toBe(true);
    expect(state.pullRequest?.title).toBe("Notify when an agent finishes work");
    expect(state.pullRequest?.additions).toBe(1487);
  });

  /// Nothing to ask about until detection has found a number — the detail endpoint takes one, and
  /// there is no branch search left to discover it.
  it("does not ask for detail before a pull request is detected", () => {
    openPullRequests.current = [];
    ship();
    expect(detailEnabled.current).toBe(false);
  });

  /// Gitea, Bitbucket and Azure DevOps answer an empty check list by construction. An empty list is
  /// also what the poll reads as "CI has not queued yet", so without this gate those forges polled
  /// at the live rate for the life of the session for an answer that can never arrive.
  it("does not poll checks on a forge that will not name them", () => {
    openPullRequests.current = [listedPullRequest()];
    hosting.current = readyHosting({ forge_enumerates_checks: false });
    ship();
    expect(checksEnabled.current).toBe(false);
    // Detection and detail are unaffected — the card still appears, just with no rollup.
    expect(lookupEnabled.current).toBe(true);
    expect(detailEnabled.current).toBe(true);
  });

  /// A merged pull request's checks cannot change, so polling them would spend a request every
  /// thirty seconds for the rest of the session to confirm a finished answer.
  it("stops polling checks once the pull request is no longer open", () => {
    openPullRequests.current = [listedPullRequest()];
    const hook = shipHook();
    expect(checksEnabled.current).toBe(true);

    openPullRequests.current = [];
    detail.current = detailInfo({ state: "Merged" });
    hook.rerender();
    expect(checksEnabled.current).toBe(false);
  });

  /// Acting on a branch an agent is still writing to is the race the idle check exists to stop.
  it("blocks both actions while the agent is mid-turn", () => {
    expect(ship({ isProcessing: true }).blocker).toBe("agent-busy");
  });

  /// The card gates its entire checks block on `ci`, and a pull request whose checks have not
  /// queued yet has no verdict to carry. Taking that `null` from anywhere but the fast poll meant
  /// the poll filled `checks` into a block that never rendered, and the user waited a full cycle
  /// to see CI appear at all.
  it("shows CI as soon as the fast poll finds a check", () => {
    openPullRequests.current = [listedPullRequest()];
    expect(ship().pullRequest?.ci).toBeNull();

    liveChecks.current = [{ name: "build", status: "Running" }];
    expect(ship().pullRequest?.ci).toBe("Pending");
  });

  /// The verdict, the rows and the fix prompt are three readings of one answer. Sourcing them
  /// separately let the ring show a finished matrix under a header still saying "Pending", and
  /// seeded the agent prompt with a check that had since gone green.
  it("re-derives the verdict and the failing names from the checks it renders", () => {
    openPullRequests.current = [listedPullRequest()];
    liveChecks.current = [
      { name: "build (windows)", status: "Failed" },
      { name: "vitest", status: "Passed" },
    ];

    const state = ship();
    expect(state.pullRequest?.ci).toBe("Failing");
    expect(state.pullRequest?.failing_checks).toEqual(["build (windows)"]);
    expect(state.pullRequest?.checks).toBe(liveChecks.current);
  });

  /// A branch the list does not mention may only have been asked about before the pull request
  /// existed — one opened on the forge a minute ago reaches the session this way. The floor lives
  /// inside the refresh, so a session on a branch that will never have one is not a request per
  /// switch.
  it("asks the list again when it has no pull request for the branch", () => {
    ship();
    expect(refresh).toHaveBeenCalled();

    refresh.mockClear();
    openPullRequests.current = [listedPullRequest()];
    ship();
    expect(refresh).not.toHaveBeenCalled();
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
