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

/// The project's landing mode decides which option the dialog opens on. It is a preference, so it
/// only ever picks between options that are already on offer, and a preference the project cannot
/// currently act on falls back to merging rather than to a radio that is not rendered.
describe("ApproveModal and the project's landing mode", () => {
  beforeEach(() => {
    onConfirm.mockClear();
  });

  /// Confirming without touching anything is the case that matters: it is what the setting is
  /// for, and it is the only way to observe the default the dialog opened on.
  async function confirmWithoutChoosing() {
    await userEvent.setup().click(screen.getByRole("button", { name: "Confirm" }));
    return (onConfirm.mock.calls[0]?.[0] as { mergeStrategy: string } | undefined)?.mergeStrategy;
  }

  it("merges by default when the project has said nothing", async () => {
    renderModal({ pushRemote: "origin", pullRequestProvider: "github" });

    expect(await confirmWithoutChoosing()).toBe("merge-delete");
  });

  it("opens on the pull request when the project lands that way", async () => {
    renderModal({
      pushRemote: "origin",
      pullRequestProvider: "github",
      landingMode: "PullRequest",
    });

    expect(await confirmWithoutChoosing()).toBe("pull-request");
  });

  it("opens on push when the project lands that way", async () => {
    renderModal({ pushRemote: "origin", landingMode: "PushOnly" });

    expect(await confirmWithoutChoosing()).toBe("commit-push");
  });

  /// The regression this fallback exists to prevent: a project configured for pull requests whose
  /// forge nobody has connected would otherwise open on an option the dialog does not render.
  it("falls back to merging when the forge is not connected", async () => {
    renderModal({
      pushRemote: "origin",
      pullRequestProvider: "github",
      pullRequestNeedsConnecting: true,
      landingMode: "PullRequest",
    });

    expect(screen.queryByText(/Open a pull request/)).not.toBeInTheDocument();
    expect(await confirmWithoutChoosing()).toBe("merge-delete");
  });

  it("falls back to merging when there is no remote to push to", async () => {
    renderModal({ pushRemote: null, landingMode: "PushOnly" });

    expect(await confirmWithoutChoosing()).toBe("merge-delete");
  });

  /// The status query resolves after the dialog has mounted, so the preferred option appears
  /// under it. The default has to follow, or the setting is honoured only on a warm cache.
  it("adopts the preference once the forge answers", async () => {
    const { rerender } = renderModal({
      pushRemote: null,
      landingMode: "PullRequest",
      forgeSupportsPullRequests: false,
    });

    rerender(
      <ApproveModal
        open
        onOpenChange={vi.fn()}
        hasWorktree
        hasUncommitted
        untrackedCount={0}
        commitMessage="Add the thing"
        onConfirm={onConfirm}
        forgeSupportsPullRequests
        pushRemote="origin"
        pullRequestProvider="github"
        landingMode="PullRequest"
      />,
    );

    expect(await confirmWithoutChoosing()).toBe("pull-request");
  });
});
