import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApproveModal } from "./ReviewConfirmModals";

const onConfirm = vi.fn();

function renderModal(props: Partial<Parameters<typeof ApproveModal>[0]> = {}) {
  return render(
    <ApproveModal
      open
      onOpenChange={vi.fn()}
      hasWorktree
      hasUncommitted
      untrackedCount={0}
      commitMessage="Add the thing"
      onConfirm={onConfirm}
      {...props}
    />,
  );
}

describe("ApproveModal", () => {
  beforeEach(() => {
    onConfirm.mockClear();
  });

  it("offers no push option when the project has no remote", () => {
    renderModal({ pushRemote: null });

    expect(screen.getByText(/Commit \+ Merge \+ Delete worktree/)).toBeInTheDocument();
    expect(screen.queryByText(/Commit \+ Push/)).not.toBeInTheDocument();
  });

  it("names the remote it would push to", () => {
    renderModal({ pushRemote: "upstream" });

    expect(screen.getByText(/Commit \+ Push to upstream/)).toBeInTheDocument();
  });

  // The push option used to be unreachable on a fully committed branch, because the strategy
  // radio only appeared when there was something to commit. Pushing an already-committed
  // branch is the ordinary case, not an edge one.
  it("still offers the choice when everything is already committed", () => {
    renderModal({ hasUncommitted: false, pushRemote: "origin" });

    expect(screen.getByText(/Commit \+ Push to origin/)).toBeInTheDocument();
  });

  it("reports the push strategy back to the caller", async () => {
    const user = userEvent.setup();
    renderModal({ pushRemote: "origin" });

    await user.click(screen.getByText(/Commit \+ Push to origin/));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ mergeStrategy: "commit-push" }),
    );
  });
});
