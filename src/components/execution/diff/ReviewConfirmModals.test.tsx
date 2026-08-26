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
      // The existing cases all describe a forge Maestro can post to; the ones that do not say so
      // explicitly.
      forgeSupportsPullRequests
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

  it("offers no pull request until a forge answers for the remote", () => {
    renderModal({ pushRemote: "origin" });

    expect(screen.getByText(/Commit \+ Push to origin/)).toBeInTheDocument();
    expect(screen.queryByText(/Open a pull request/)).not.toBeInTheDocument();
  });

  // Rung 3: the forge is known but nothing has authenticated for it. An invitation, not an
  // error — every other way of approving has to stay available.
  it("invites the user to connect rather than hiding the reason", () => {
    renderModal({
      pushRemote: "origin",
      pullRequestNeedsConnecting: true,
      pullRequestProvider: "github",
    });

    expect(screen.queryByText(/Open a pull request/)).not.toBeInTheDocument();
    expect(screen.getByText(/Connect github in Settings/)).toBeInTheDocument();
    expect(screen.getByText(/Commit \+ Merge \+ Delete worktree/)).toBeInTheDocument();
  });

  // A connected forge is not necessarily one Maestro can post to. Bitbucket reaches rung Ready
  // as soon as a credential answers, and offering the option there ends in a pushed branch, no
  // pull request, and a task stuck in Review.
  it("offers no pull request on a forge it cannot post to", () => {
    renderModal({
      pushRemote: "origin",
      pullRequestProvider: "bitbucket",
      forgeSupportsPullRequests: false,
    });

    expect(screen.getByText(/Commit \+ Push to origin/)).toBeInTheDocument();
    expect(screen.queryByText(/Open a pull request/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Connect bitbucket in Settings/)).not.toBeInTheDocument();
  });

  // Asking someone to go and authenticate a forge that still could not open a pull request sends
  // them after work that changes nothing.
  it("invites connecting only a forge that could then open one", () => {
    renderModal({
      pushRemote: "origin",
      pullRequestNeedsConnecting: true,
      pullRequestProvider: "bitbucket",
      forgeSupportsPullRequests: false,
    });

    expect(screen.queryByText(/Connect bitbucket in Settings/)).not.toBeInTheDocument();
  });

  it("reports the pull request strategy back to the caller", async () => {
    const user = userEvent.setup();
    renderModal({ pushRemote: "origin", pullRequestProvider: "github" });

    await user.click(screen.getByText(/Open a pull request/));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ mergeStrategy: "pull-request" }),
    );
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
