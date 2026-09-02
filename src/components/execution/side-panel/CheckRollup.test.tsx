import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BranchPullRequestInfo, PullRequestCheckInfo } from "@/types/bindings";

vi.mock("@/services/task.service", () => ({
  useTaskAttachmentsQuery: () => ({ data: [] }),
  useTasksQuery: () => ({ data: [] }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { CheckRollup, PullRequestFacts, branchSummary } = await import("./OverviewPanel");

function pullRequest(overrides: Partial<BranchPullRequestInfo> = {}): BranchPullRequestInfo {
  return {
    number: 310,
    url: "https://github.com/emdgroup/maestro/pull/310",
    title: "Ship pull requests from the session panel",
    state: "Open",
    ci: "Pending",
    failing_checks: [],
    checks: [],
    head_sha: "deadbeef",
    created_at: null,
    base_branch: "main",
    head_branch: "maestro/great-lynx-58",
    commits: 2,
    changed_files: 22,
    additions: 1487,
    deletions: 18,
    mergeable: null,
    ...overrides,
  };
}

function check(name: string, status: PullRequestCheckInfo["status"]): PullRequestCheckInfo {
  return { name, status };
}

describe("CheckRollup", () => {
  /// The card previously said "checks running" in the header and "checks running" again in the
  /// body. The ring replaces the second copy with progress the header cannot express.
  it("counts what has finished, not what has passed", () => {
    render(
      <CheckRollup
        ci="Failing"
        checks={[
          check("build (windows)", "Failed"),
          check("e2e", "Running"),
          check("cargo test", "Passed"),
          check("vitest", "Passed"),
        ]}
      />,
    );
    // Three of four have a result. A failure is done, whatever else is still going.
    expect(screen.getByText("3 of 4 checks done")).toBeInTheDocument();
    expect(screen.getByText("1 failing · 1 running")).toBeInTheDocument();
  });

  /// A red check is the one thing on this card that needs a decision. Hiding it behind a click is
  /// how it gets missed, so a failure opens the list itself.
  it("opens itself when something has failed", () => {
    render(
      <CheckRollup
        ci="Failing"
        checks={[check("lint", "Passed"), check("build", "Failed"), check("e2e", "Running")]}
      />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    // Worst first, so the failure is the row nearest the ring.
    expect(screen.getAllByTestId("check-name").map((n) => n.textContent)).toEqual([
      "build",
      "e2e",
      "lint",
    ]);
  });

  /// Nothing red means nothing to decide, and the ring already says how far along the run is.
  it("stays shut while everything is fine, and opens on demand", async () => {
    const user = userEvent.setup();
    render(
      <CheckRollup ci="Pending" checks={[check("lint", "Passed"), check("e2e", "Running")]} />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("check-name")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByTestId("check-name")).toHaveLength(2);
  });

  /// The card itself opens the forge on click. Without stopPropagation, expanding the list would
  /// also launch a browser tab.
  it("does not let the toggle reach the card", async () => {
    const user = userEvent.setup();
    const onCardClick = vi.fn();
    render(
      <div onClick={onCardClick}>
        <CheckRollup ci="Passing" checks={[check("lint", "Passed")]} />
      </div>,
    );
    await user.click(screen.getByRole("button"));
    expect(onCardClick).not.toHaveBeenCalled();
  });

  /// Gitea and Forgejo enumerate nothing. A ring drawn at zero of zero would claim a run that does
  /// not exist, so the bare verdict stands in.
  it("falls back to the verdict when the forge names no checks", () => {
    render(<CheckRollup ci="Pending" checks={[]} />);
    expect(screen.getByText("checks running")).toBeInTheDocument();
    expect(screen.queryByTestId("failing-names")).not.toBeInTheDocument();
  });

  /// "2 of 2 checks done" is true and still reads like something might be pending.
  it("says so plainly when everything passed", () => {
    render(
      <CheckRollup ci="Passing" checks={[check("build", "Passed"), check("e2e", "Passed")]} />,
    );
    expect(screen.getByText("All 2 checks passed")).toBeInTheDocument();
    expect(screen.queryByTestId("failing-names")).not.toBeInTheDocument();
  });

  it("singularises a lone check", () => {
    render(<CheckRollup ci="Passing" checks={[check("build", "Passed")]} />);
    expect(screen.getByText("All 1 check passed")).toBeInTheDocument();
  });
});

describe("branchSummary", () => {
  /// `head → base` rather than a sentence: the branch names are the content, and "into"/"from"
  /// spend the column's width on words that are identical on every card.
  it("reads as the card subtitle", () => {
    expect(branchSummary(pullRequest())).toBe("maestro/great-lynx-58 → main · 2 commits");
    expect(branchSummary(pullRequest({ commits: 1 }))).toBe(
      "maestro/great-lynx-58 → main · 1 commit",
    );
    expect(branchSummary(pullRequest({ commits: null }))).toBe("maestro/great-lynx-58 → main");
  });

  /// A subtitle reading " → " is worse than falling back to the number, which is what a null
  /// return asks the caller to do.
  it("declines when the forge named neither branch", () => {
    expect(branchSummary(pullRequest({ base_branch: null }))).toBeNull();
    expect(branchSummary(pullRequest({ head_branch: null }))).toBeNull();
  });
});

describe("PullRequestFacts", () => {
  it("shows size and age in the metrics vocabulary", () => {
    render(
      <PullRequestFacts pullRequest={pullRequest({ created_at: new Date().toISOString() })} />,
    );
    expect(screen.getByText("just now")).toBeInTheDocument();
    // Count and noun in one node: split across two, the row's gap landed between them and "23
    // files" rendered wider-spaced than the gap either side of the icon.
    expect(screen.getByText("22 files")).toBeInTheDocument();
    expect(screen.getByText("+1487")).toBeInTheDocument();
    expect(screen.getByText("−18")).toBeInTheDocument();
  });

  /// GitLab reports no line counts on the merge request. Rendering them anyway would put
  /// "0 files +0 −0" on a card describing real work.
  it("drops the metrics a forge would not answer", () => {
    render(
      <PullRequestFacts
        pullRequest={pullRequest({
          changed_files: null,
          additions: null,
          deletions: null,
          created_at: null,
        })}
      />,
    );
    expect(screen.queryByText(/files/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\+/)).not.toBeInTheDocument();
  });

  /// Nothing to say and nothing wrong means no row at all, rather than an empty strip of padding.
  it("renders nothing when it has nothing to report", () => {
    const { container } = render(
      <PullRequestFacts
        pullRequest={pullRequest({
          changed_files: null,
          additions: null,
          deletions: null,
          created_at: null,
          mergeable: true,
        })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  /// `null` is the forge still computing the merge commit, which is what every freshly pushed
  /// branch returns. Warning on it would train the user to ignore the warning.
  it("warns about conflicts only on a positive answer", () => {
    render(<PullRequestFacts pullRequest={pullRequest({ mergeable: null })} />);
    expect(screen.queryByText(/Conflicts/)).not.toBeInTheDocument();

    render(<PullRequestFacts pullRequest={pullRequest({ mergeable: true })} />);
    expect(screen.queryByText(/Conflicts/)).not.toBeInTheDocument();

    render(<PullRequestFacts pullRequest={pullRequest({ mergeable: false })} />);
    expect(screen.getByText("Conflicts with main")).toBeInTheDocument();
  });

  it("singularises a one-file pull request", () => {
    render(<PullRequestFacts pullRequest={pullRequest({ changed_files: 1, created_at: null })} />);
    expect(screen.getByText("1 file")).toBeInTheDocument();
  });
});
