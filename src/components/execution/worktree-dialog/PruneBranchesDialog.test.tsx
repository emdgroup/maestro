import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("@/services/worktree.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/worktree.service")>()),
  usePruneBranchesMutation: vi.fn(),
}));

import { usePruneBranchesMutation } from "@/services/worktree.service";
import { PruneBranchesDialog } from "./PruneBranchesDialog";
import type { PrunableBranch } from "@/types/bindings";

const MERGED_ONE: PrunableBranch = {
  name: "maestro/kind-heath-19",
  merged: true,
  last_commit_at: "2026-08-20T09:30:00+02:00",
  commits: 0,
  diff_stat: null,
};

const MERGED_TWO: PrunableBranch = {
  name: "maestro/lone-hill-5",
  merged: true,
  last_commit_at: "2026-08-15T09:30:00+02:00",
  commits: 0,
  diff_stat: null,
};

const UNMERGED: PrunableBranch = {
  name: "maestro/scratch-test",
  merged: false,
  last_commit_at: "2026-08-27T07:15:00+02:00",
  commits: 4,
  diff_stat: "3 files changed, 182 insertions(+), 37 deletions(-)",
};

const mutate = vi.fn();

function renderDialog(branches: PrunableBranch[]) {
  return render(
    <PruneBranchesDialog open onOpenChange={vi.fn()} projectId={1} branches={branches} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  (usePruneBranchesMutation as ReturnType<typeof vi.fn>).mockReturnValue({
    mutate,
    isPending: false,
  });
});

describe("PruneBranchesDialog", () => {
  it("preselects merged branches and leaves unmerged ones untouched", () => {
    renderDialog([MERGED_ONE, MERGED_TWO, UNMERGED]);

    expect(screen.getByRole("checkbox", { name: MERGED_ONE.name })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: MERGED_TWO.name })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: UNMERGED.name })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Prune 2 branches" })).toBeEnabled();
  });

  it("shows commit and diff detail for unmerged branches only", () => {
    renderDialog([MERGED_ONE, UNMERGED]);

    expect(screen.getByText("4 commits")).toBeInTheDocument();
    expect(screen.getByText("+182")).toBeInTheDocument();
    expect(screen.getByText("-37")).toBeInTheDocument();
  });

  it("prunes only the checked branches without forcing", async () => {
    const user = userEvent.setup();
    renderDialog([MERGED_ONE, MERGED_TWO, UNMERGED]);

    await user.click(screen.getByRole("checkbox", { name: MERGED_TWO.name }));
    await user.click(screen.getByRole("button", { name: "Prune 1 branch" }));

    expect(mutate).toHaveBeenCalledWith(
      { projectId: 1, branches: [MERGED_ONE.name], force: false },
      expect.anything(),
    );
  });

  /// Ticking an unmerged row is the only opt-in to `git branch -D`, so it has to both warn and
  /// carry the force flag through — a silent upgrade to a destructive delete is the bug here.
  it("warns and forces once an unmerged branch is selected", async () => {
    const user = userEvent.setup();
    renderDialog([MERGED_ONE, UNMERGED]);

    expect(screen.queryByText(/cannot be recovered/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: UNMERGED.name }));

    expect(screen.getByText(/cannot be recovered/)).toBeInTheDocument();
    expect(screen.getByText(/4 commits exist on no other branch/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Prune 2 branches" }));

    expect(mutate).toHaveBeenCalledWith(
      { projectId: 1, branches: [MERGED_ONE.name, UNMERGED.name], force: true },
      expect.anything(),
    );
  });

  it("disables the confirm when nothing is selected", async () => {
    const user = userEvent.setup();
    renderDialog([MERGED_ONE]);

    await user.click(screen.getByRole("checkbox", { name: MERGED_ONE.name }));

    expect(screen.getByRole("button", { name: "Prune 0 branches" })).toBeDisabled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("clicking the row toggles the branch exactly once", async () => {
    const user = userEvent.setup();
    renderDialog([UNMERGED]);

    // The row label, not the checkbox — the row's own click handler must not double-fire
    // against the checkbox's change handler.
    await user.click(screen.getByText(UNMERGED.name));

    expect(screen.getByRole("checkbox", { name: UNMERGED.name })).toBeChecked();
  });
});
