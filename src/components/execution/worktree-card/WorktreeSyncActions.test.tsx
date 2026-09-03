import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorktreeSyncActions, hasSyncActions, syncActions } from "./WorktreeSyncActions";
import { WorktreeMetrics } from "./WorktreeMetrics";
import type { WorktreeWithStatus } from "@/types/bindings";

const push = vi.hoisted(() => vi.fn());
const pull = vi.hoisted(() => vi.fn());

vi.mock("@/services/worktree.service", () => ({
  usePushWorktreeMutation: () => ({ mutate: push, isPending: false }),
  usePullWorktreeMutation: () => ({ mutate: pull, isPending: false }),
}));

function worktree(overrides: Partial<WorktreeWithStatus> = {}): WorktreeWithStatus {
  return {
    id: 1,
    project_id: 1,
    task_id: null,
    path: "/repo/.maestro/worktrees/session-1",
    branch_name: "maestro/some-branch",
    base_branch: "main",
    created_at: null,
    task_name: null,
    changed_files_count: 0,
    diff_stat: null,
    ahead_behind: { ahead: 2, behind: 3 },
    commit_count: null,
    last_activity_at: null,
    last_commit_subject: null,
    detached_at: null,
    is_zombie: false,
    is_orphan: false,
    ...overrides,
  };
}

function renderActions(wt: WorktreeWithStatus, inUse = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <WorktreeSyncActions worktree={wt} projectId={1} inUse={inUse} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  push.mockClear();
  pull.mockClear();
});

describe("syncActions", () => {
  it("offers both directions with their counts when the branch tracks a remote", () => {
    const { push: up, pull: down, publish } = syncActions(worktree(), false);

    expect(publish).toBe(false);
    expect(up).toMatchObject({ show: true, count: 2 });
    expect(down).toMatchObject({ show: true, count: 3 });
  });

  /**
   * The single rule: a chip exists only when it has commits to move. A settled worktree keeps the
   * card exactly as it read before this feature, and the refresh button is what re-reads the
   * counts.
   */
  it("offers nothing when the branch is level with its remote", () => {
    const level = worktree({ ahead_behind: { ahead: 0, behind: 0 } });

    expect(syncActions(level, false).push.show).toBe(false);
    expect(syncActions(level, false).pull.show).toBe(false);
    expect(hasSyncActions(level)).toBe(false);
  });

  it("offers only the direction that has commits", () => {
    const aheadOnly = syncActions(worktree({ ahead_behind: { ahead: 3, behind: 0 } }), false);
    expect(aheadOnly.push).toMatchObject({ show: true, count: 3 });
    expect(aheadOnly.pull.show).toBe(false);

    const behindOnly = syncActions(worktree({ ahead_behind: { ahead: 0, behind: 1 } }), false);
    expect(behindOnly.push.show).toBe(false);
    expect(behindOnly.pull).toMatchObject({ show: true, count: 1 });
  });

  /**
   * The branch line already reads `detached at <sha>` in warning colour, and a detached head has
   * no branch for either direction to move.
   */
  it("offers nothing at all on a detached head", () => {
    const detached = worktree({ detached_at: "a3f19c2" });

    expect(syncActions(detached, false).push.show).toBe(false);
    expect(syncActions(detached, false).pull.show).toBe(false);
    expect(hasSyncActions(detached)).toBe(false);
  });

  /**
   * `ahead_behind` is null exactly when there is no upstream — the same reading
   * `DeleteWorktreeDialog` relies on to decide a branch is local-only. The push would create the
   * branch, and what it sends is the branch's own commits.
   */
  it("counts an unpublished branch's own commits as what a push would send", () => {
    const actions = syncActions(worktree({ ahead_behind: null, commit_count: 4 }), false);

    expect(actions.publish).toBe(true);
    expect(actions.push).toMatchObject({ show: true, count: 4 });
    expect(actions.push.reason).toMatch(/create this branch on the remote/i);
    expect(actions.pull.show).toBe(false);
  });

  /** An unpublished branch with no commits of its own is not worth a ref on the remote. */
  it("offers nothing for an unpublished branch that has no commits", () => {
    expect(hasSyncActions(worktree({ ahead_behind: null, commit_count: 0 }))).toBe(false);
    expect(hasSyncActions(worktree({ ahead_behind: null, commit_count: null }))).toBe(false);
  });

  it("warns on the push tooltip that uncommitted files are not included", () => {
    const actions = syncActions(worktree({ changed_files_count: 5 }), false);

    expect(actions.push.reason).toMatch(/5 uncommitted files will not be included/i);
  });
});

describe("WorktreeSyncActions", () => {
  it("pushes the branch straight away", async () => {
    const user = userEvent.setup();
    renderActions(worktree());

    await user.click(screen.getByRole("button", { name: "Push to remote" }));

    expect(push).toHaveBeenCalledWith({
      projectId: 1,
      worktreePath: "/repo/.maestro/worktrees/session-1",
      branchName: "maestro/some-branch",
    });
  });

  it("pulls straight away when nothing is running in the worktree", async () => {
    const user = userEvent.setup();
    renderActions(worktree());

    await user.click(screen.getByRole("button", { name: "Pull from remote" }));

    expect(pull).toHaveBeenCalledWith({
      projectId: 1,
      worktreePath: "/repo/.maestro/worktrees/session-1",
    });
  });

  /**
   * A pull rewrites files under whatever is working in them. This is the one confirmation in the
   * feature — everything else either succeeds or fails without touching the worktree.
   */
  it("asks before pulling into a worktree that is in use", async () => {
    const user = userEvent.setup();
    renderActions(worktree(), true);

    await user.click(screen.getByRole("button", { name: "Pull from remote" }));

    expect(pull).not.toHaveBeenCalled();
    expect(screen.getByText("Pull into a worktree that is in use?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Pull anyway" }));
    expect(pull).toHaveBeenCalledOnce();
  });

  it("does not pull when the confirmation is dismissed", async () => {
    const user = userEvent.setup();
    renderActions(worktree(), true);

    await user.click(screen.getByRole("button", { name: "Pull from remote" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(pull).not.toHaveBeenCalled();
  });

  /**
   * A worktree made by hand with `git worktree add` has no row in the `worktrees` table, and
   * neither does the repository checkout itself — both arrive with `project_id: null`. Reading the
   * id off the worktree left every such card without controls, which in a repository nobody had
   * created through Maestro meant all of them. The id comes from the view instead.
   */
  it("acts on a worktree that has no database row of its own", async () => {
    const user = userEvent.setup();
    renderActions(worktree({ id: null, project_id: null, is_orphan: true }));

    await user.click(screen.getByRole("button", { name: "Push to remote" }));

    expect(push).toHaveBeenCalledWith(expect.objectContaining({ projectId: 1 }));
  });

  /** An unpublished branch gets the ordinary push arrow, not a differently-shaped control. */
  it("renders an unpublished branch as the same push arrow with its commit count", () => {
    renderActions(worktree({ ahead_behind: null, commit_count: 4 }));

    expect(screen.getByRole("button", { name: "Push to remote" })).toHaveTextContent(/↑4/);
    expect(screen.queryByRole("button", { name: "Pull from remote" })).not.toBeInTheDocument();
  });

  /** The arrow and number alone do not read as a control, so hovering names the verb. */
  it("carries the verb for the chip to widen into on hover", () => {
    renderActions(worktree());

    expect(screen.getByRole("button", { name: "Push to remote" })).toHaveTextContent("Push");
    expect(screen.getByRole("button", { name: "Pull from remote" })).toHaveTextContent("Pull");
  });
});

/**
 * `WorktreeMetrics` is shared with the workspace picker, which has no business pushing anything.
 * Without the `sync` slot it must behave exactly as it did before the slot existed.
 */
describe("WorktreeMetrics without the sync slot", () => {
  it("still drops the remote segment entirely when the branch is level", () => {
    const { container } = render(
      <WorktreeMetrics worktree={worktree({ ahead_behind: { ahead: 0, behind: 0 } })} now={0} />,
    );

    expect(container.textContent).not.toMatch(/[↑↓]/);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("still renders the counts as plain text when they are not zero", () => {
    render(<WorktreeMetrics worktree={worktree()} now={0} />);

    expect(screen.getByText("↑2")).toBeInTheDocument();
    expect(screen.getByText("↓3")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
