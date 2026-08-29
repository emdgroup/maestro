import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorktreeCard } from "./WorktreeCard";
import { defaultScope } from "@/components/execution/diff/WorktreeDiffPanel";
import { useNavigationStore } from "@/store/navigationStore";
import type { ActiveSessionInfo, WorktreeWithStatus } from "@/types/bindings";

/**
 * A worktree whose agent has finished and committed has a clean working tree, so every field the
 * card can see about uncommitted work reads empty. It still has a branch worth reviewing, and it
 * used to be unopenable — the click was swallowed with nothing on the card to explain it.
 */
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
    cwd: "/repo/.maestro/worktrees/session-1",
    supports_session_list: false,
    supports_session_load: false,
    supports_session_close: false,
    supports_session_delete: false,
    project_id: 1,
    ...overrides,
  };
}

const NOW = Date.parse("2026-08-29T12:00:00Z");

function renderCard(
  wt: WorktreeWithStatus,
  { sessions = [] as ActiveSessionInfo[], onSelect = vi.fn(), onDelete = vi.fn() } = {},
) {
  render(
    <WorktreeCard
      worktree={wt}
      repoPath="/repo"
      sessions={sessions}
      now={NOW}
      onSelect={onSelect}
      onDelete={onDelete}
    />,
  );
  return { onSelect, onDelete };
}

beforeEach(() => {
  useNavigationStore.setState({
    activeTab: "worktrees",
    activeTaskId: null,
    pendingAgentId: null,
    pendingSessionKey: null,
    pendingWorktreeId: null,
  });
});

describe("WorktreeCard", () => {
  it("opens a worktree whose work is all committed", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderCard(worktree());

    await user.click(screen.getByText("maestro/some-branch"));

    expect(onSelect).toHaveBeenCalledWith("/repo/.maestro/worktrees/session-1");
  });

  // `ahead_behind` counts against the upstream, so a pushed branch reads 0/0 and cannot be used
  // to detect reviewable work. Pinned because it is the obvious-looking fix that does not work.
  it("opens a pushed branch, which is level with its upstream", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderCard(worktree({ ahead_behind: { ahead: 0, behind: 0 } }));

    await user.click(screen.getByText("maestro/some-branch"));

    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("does not open the diff when the delete button is pressed", async () => {
    const user = userEvent.setup();
    const { onSelect, onDelete } = renderCard(worktree());

    await user.click(screen.getByRole("button", { name: "Delete worktree" }));

    expect(onDelete).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("WorktreeCard identity", () => {
  it("titles the card with the task, and keeps the folder name for the branch line", () => {
    renderCard(worktree({ task_id: 7, task_name: "Fix the diff panel" }));

    expect(screen.getByText("Fix the diff panel")).toBeInTheDocument();
    expect(screen.getByText("maestro/some-branch")).toBeInTheDocument();
  });

  it("falls back to the folder name when there is no task", () => {
    renderCard(worktree());

    expect(screen.getByText("session-1")).toBeInTheDocument();
  });

  /**
   * The tooltip exists to recover the folder name the task title displaced. With no task the title
   * already *is* the folder name, so a tooltip would fire on every hover across the grid to repeat
   * what is already on screen.
   *
   * Asserted on the trigger rather than the tooltip's text because base-ui portals the popup and
   * happy-dom does not mount it; the conditional is what this is pinning either way.
   */
  it("carries a tooltip only when a task displaced the folder name", () => {
    const withTask = render(
      <WorktreeCard
        worktree={worktree({ task_id: 7, task_name: "Fix the diff panel" })}
        repoPath="/repo"
        sessions={[]}
        now={NOW}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(withTask.container.querySelector("[data-slot='tooltip-trigger']")).not.toBeNull();

    const withoutTask = render(
      <WorktreeCard
        worktree={worktree()}
        repoPath="/repo"
        sessions={[]}
        now={NOW}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(withoutTask.container.querySelector("[data-slot='tooltip-trigger']")).toBeNull();
  });

  /**
   * `branch_name` keeps the name recorded at creation because branch operations still need it.
   * Rendering it would tell the user a branch is checked out when it is not.
   */
  it("says the head is detached instead of naming a branch that is not checked out", () => {
    renderCard(worktree({ detached_at: "a3f19c2" }));

    expect(screen.getByText("detached at a3f19c2")).toBeInTheDocument();
    expect(screen.queryByText("maestro/some-branch")).not.toBeInTheDocument();
  });
});

describe("WorktreeCard metrics", () => {
  it("shows nothing at all for a worktree with no activity, changes or commits", () => {
    // A digit-free path and branch, so any digit on the card can only have come from a metric.
    const { container } = render(
      <WorktreeCard
        worktree={worktree({
          path: "/repo/.maestro/worktrees/scratch",
          branch_name: "maestro/quiet",
        })}
        repoPath="/repo"
        sessions={[]}
        now={NOW}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    // No zeroes and no words explaining them — the row is simply absent.
    expect(container.textContent).not.toMatch(/\d/);
  });

  it("drops the counts that are zero and keeps the ones that are not", () => {
    renderCard(
      worktree({
        diff_stat: "2 files changed, 14 insertions(+)",
        commit_count: 3,
        ahead_behind: { ahead: 3, behind: 0 },
        last_activity_at: new Date(NOW - 5 * 60_000).toISOString(),
      }),
    );

    expect(screen.getByText("+14")).toBeInTheDocument();
    expect(screen.getByText("↑3")).toBeInTheDocument();
    expect(screen.getByText("5 min")).toBeInTheDocument();
    expect(screen.queryByText(/^−/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^↓/)).not.toBeInTheDocument();
  });
});

describe("WorktreeCard footer", () => {
  it("has no footer when nothing in Maestro is using the worktree", () => {
    renderCard(worktree());

    expect(screen.queryByRole("button", { name: /used by/i })).not.toBeInTheDocument();
    expect(screen.queryByText("USED BY")).not.toBeInTheDocument();
  });

  it("lists the task and each ACP session, and counts shells without listing them", async () => {
    const user = userEvent.setup();
    renderCard(worktree({ task_id: 7, task_name: "Fix the diff panel" }), {
      sessions: [
        session({ session_key: 11, session_name: "claude" }),
        session({ session_key: 12, session_name: "gemini" }),
        session({ session_key: 13, execution_mode: "pty" }),
        // A session in a different worktree must not be counted here.
        session({ session_key: 14, cwd: "/repo/.maestro/worktrees/session-2" }),
      ],
    });

    await user.click(screen.getByRole("button", { name: "Show what uses this worktree" }));

    expect(screen.getByRole("button", { name: "Fix the diff panel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "claude" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "gemini" })).toBeInTheDocument();
    expect(screen.getByText("1 shell running here")).toBeInTheDocument();
    // The session in a sibling worktree is neither listed nor counted.
    expect(screen.queryByText("2 shells running here")).not.toBeInTheDocument();
  });

  it("navigates to the specific session that was clicked", async () => {
    const user = userEvent.setup();
    renderCard(worktree(), {
      sessions: [
        session({ session_key: 11, session_name: "claude" }),
        session({ session_key: 12, session_name: "gemini" }),
      ],
    });

    await user.click(screen.getByRole("button", { name: "Show what uses this worktree" }));
    await user.click(screen.getByRole("button", { name: "gemini" }));

    const state = useNavigationStore.getState();
    expect(state.activeTab).toBe("agents");
    expect(state.pendingSessionKey).toBe(12);
  });

  it("navigates to the task", async () => {
    const user = userEvent.setup();
    renderCard(worktree({ task_id: 7, task_name: "Fix the diff panel" }));

    await user.click(screen.getByRole("button", { name: "Show what uses this worktree" }));
    await user.click(screen.getByRole("button", { name: "Fix the diff panel" }));

    const state = useNavigationStore.getState();
    expect(state.activeTab).toBe("kanban");
    expect(state.activeTaskId).toBe(7);
  });
});

/**
 * Opening the card is only half of it: a committed worktree opened on the uncommitted scope shows
 * an empty panel, which is the same confusion by another route.
 */
describe("defaultScope", () => {
  it("opens a committed worktree on everything since the base branch", () => {
    expect(defaultScope(worktree())).toEqual({ type: "all" });
  });

  it("opens a dirty worktree on its uncommitted changes", () => {
    expect(defaultScope(worktree({ changed_files_count: 2 }))).toEqual({ type: "uncommitted" });
    expect(defaultScope(worktree({ diff_stat: "1 file changed" }))).toEqual({
      type: "uncommitted",
    });
  });

  // The panel is handed null while its dialog is closed; that must not pick a scope for the next
  // worktree to inherit.
  it("leaves the scope alone when there is no worktree", () => {
    expect(defaultScope(null)).toEqual({ type: "uncommitted" });
  });
});
