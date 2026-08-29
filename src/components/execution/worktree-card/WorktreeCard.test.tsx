import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorktreeCard } from "./WorktreeCard";
import { defaultScope } from "@/components/execution/diff/WorktreeDiffPanel";
import type { WorktreeWithStatus } from "@/types/bindings";

/**
 * A worktree whose agent has finished and committed has a clean working tree, so every field the
 * card can see about uncommitted work reads empty. It still has a branch worth reviewing, and it
 * used to be unopenable — the click was swallowed with nothing on the card to explain it.
 */
function worktree(overrides: Partial<WorktreeWithStatus> = {}): WorktreeWithStatus {
  return {
    id: 1,
    path: "/repo/.maestro/worktrees/session-1",
    branch_name: "maestro/some-branch",
    base_branch: "main",
    created_at: null,
    changed_files_count: 0,
    diff_stat: null,
    ahead_behind: null,
    is_zombie: false,
    is_orphan: false,
    ...overrides,
  } as WorktreeWithStatus;
}

function renderCard(wt: WorktreeWithStatus, onSelect = vi.fn()) {
  render(<WorktreeCard worktree={wt} repoPath="/repo" onSelect={onSelect} onDelete={() => {}} />);
  return onSelect;
}

describe("WorktreeCard", () => {
  it("opens a worktree whose work is all committed", async () => {
    const user = userEvent.setup();
    const onSelect = renderCard({ ...worktree(), changed_files_count: 0, diff_stat: null });

    await user.click(screen.getByText("maestro/some-branch"));

    expect(onSelect).toHaveBeenCalledWith("/repo/.maestro/worktrees/session-1");
  });

  // `ahead_behind` counts against the upstream, so a pushed branch reads 0/0 and cannot be used
  // to detect reviewable work. Pinned because it is the obvious-looking fix that does not work.
  it("opens a pushed branch, which is level with its upstream", async () => {
    const user = userEvent.setup();
    const onSelect = renderCard({ ...worktree(), ahead_behind: { ahead: 0, behind: 0 } });

    await user.click(screen.getByText("maestro/some-branch"));

    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("still opens a dirty worktree", async () => {
    const user = userEvent.setup();
    const onSelect = renderCard({
      ...worktree(),
      changed_files_count: 3,
      diff_stat: "3 files changed, 10 insertions(+), 2 deletions(-)",
    });

    await user.click(screen.getByText("maestro/some-branch"));

    expect(onSelect).toHaveBeenCalledOnce();
  });

  // Deleting is a different action on the same card and must not open the diff behind the dialog.
  it("does not open the diff when the delete button is pressed", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    render(
      <WorktreeCard
        worktree={worktree()}
        repoPath="/repo"
        onSelect={onSelect}
        onDelete={onDelete}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete worktree" }));

    expect(onDelete).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
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
    expect(defaultScope({ ...worktree(), changed_files_count: 2 })).toEqual({
      type: "uncommitted",
    });
    expect(defaultScope({ ...worktree(), diff_stat: "1 file changed" })).toEqual({
      type: "uncommitted",
    });
  });

  // The panel is handed null while its dialog is closed; that must not pick a scope for the next
  // worktree to inherit.
  it("leaves the scope alone when there is no worktree", () => {
    expect(defaultScope(null)).toEqual({ type: "uncommitted" });
  });
});
