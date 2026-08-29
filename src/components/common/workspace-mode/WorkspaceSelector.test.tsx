import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceSelector } from "./WorkspaceSelector";
import type { WorktreeWithStatus } from "@/types/bindings";

/// Pulls in the project store and a branches query, and none of that is what these tests are
/// about — the branch picker only renders in the mode they never select.
vi.mock("@/components/kanban/shared/BranchPicker", () => ({
  BranchPicker: () => null,
}));

const REPO = "/repo";

function worktree(overrides: Partial<WorktreeWithStatus> = {}): WorktreeWithStatus {
  return {
    id: 1,
    path: "/repo/.maestro/worktrees/session-1",
    branch_name: "maestro/quiet-heron",
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

/// The list lives in a dropdown, so every test has to open it first.
async function openList() {
  await userEvent.click(screen.getByRole("combobox", { name: "Workspace" }));
}

function renderReuse(worktrees: WorktreeWithStatus[], props: { claimsOwnership?: boolean } = {}) {
  const onSelectedWorktreeChange = vi.fn();
  render(
    <WorkspaceSelector
      mode="ReuseWorkspace"
      onModeChange={vi.fn()}
      baseBranch="main"
      onBaseBranchChange={vi.fn()}
      worktrees={worktrees}
      repoPath={REPO}
      selectedWorktreeId={null}
      onSelectedWorktreeChange={onSelectedWorktreeChange}
      claimsOwnership={props.claimsOwnership}
    />,
  );
  return onSelectedWorktreeChange;
}

describe("WorkspaceSelector — reusing a workspace", () => {
  /// A branch name alone does not answer "which of these do I want", which is why each option is
  /// the worktree card rather than a line of text.
  it("shows what is in each workspace, not just its branch", async () => {
    renderReuse([
      worktree({
        task_name: "Rework the diff gutter",
        diff_stat: "3 files changed, 12 insertions(+), 4 deletions(-)",
        commit_count: 5,
        ahead_behind: { ahead: 2, behind: 1 },
        last_activity_at: new Date(Date.now() - 3 * 60_000).toISOString(),
      }),
    ]);
    await openList();

    const option = screen.getByRole("option");
    expect(option).toHaveTextContent("Rework the diff gutter");
    expect(option).toHaveTextContent("maestro/quiet-heron");
    expect(option).toHaveTextContent("+12");
    expect(option).toHaveTextContent("−4");
    expect(option).toHaveTextContent("5");
    expect(option).toHaveTextContent("↑2");
    expect(option).toHaveTextContent("↓1");
    expect(option).toHaveTextContent("3 min");
  });

  /// The repository directory is its own mode, so offering it here would be the same choice twice.
  it("leaves the repository root out of the list", async () => {
    renderReuse([worktree(), worktree({ id: 2, path: REPO, branch_name: "main" })]);
    await openList();

    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByText("main")).not.toBeInTheDocument();
  });

  it("selects a workspace when its card is clicked", async () => {
    const onSelect = renderReuse([worktree()]);
    await openList();

    await userEvent.click(screen.getByRole("option"));

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  /// A task takes ownership of the workspace it reuses, so one another task already holds cannot
  /// be picked — but it stays listed, naming the holder, rather than silently disappearing.
  it("blocks a workspace another task owns, and says who has it", async () => {
    const onSelect = renderReuse([worktree({ task_id: 9, task_name: "Fix diff context" })], {
      claimsOwnership: true,
    });
    await openList();

    const option = screen.getByRole("option");
    expect(option).toHaveTextContent("In use by Fix diff context");
    expect(option).toHaveAttribute("data-disabled");

    await userEvent.click(option);
    expect(onSelect).not.toHaveBeenCalled();
  });

  /// A session claims nothing, so the same workspace is selectable there.
  it("leaves that workspace selectable for a session, which claims nothing", async () => {
    const onSelect = renderReuse([worktree({ task_id: 9, task_name: "Fix diff context" })]);
    await openList();

    const option = screen.getByRole("option");
    expect(option).not.toHaveAttribute("data-disabled");

    await userEvent.click(option);
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
