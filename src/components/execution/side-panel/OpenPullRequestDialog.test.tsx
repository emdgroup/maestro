import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";

vi.mock("@/services/task.service", () => ({
  useProjectBranchesQuery: () => ({ data: [{ local: ["main", "develop"], remote: [] }, "main"] }),
}));

vi.mock("@/services/integration.service", () => ({
  useOpenPullRequestForBranch: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

const { OpenPullRequestDialog } = await import("./OpenPullRequestDialog");

type Props = Parameters<typeof OpenPullRequestDialog>[0];

function props(overrides: Partial<Props> = {}): Props {
  return {
    open: true,
    onOpenChange: vi.fn(),
    projectId: 1,
    branch: "maestro/great-lynx-58",
    baseBranch: "origin/main",
    concurrentSessions: [],
    lastCommitSubject: null,
    onOpened: vi.fn(),
    ...overrides,
  };
}

/**
 * By slot rather than by role or label: the combobox renders more than one input and the two
 * fields have no `htmlFor` between their labels and controls.
 */
function field(slot: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(`input[data-slot="${slot}"]`);
  if (!found) throw new Error(`no ${slot} field rendered`);
  return found;
}

const title = () => field("input");
const target = () => field("input-group-control");

describe("OpenPullRequestDialog", () => {
  /// The Overview card renders this dialog unconditionally and opens it by prop, so it mounts
  /// moments after the worktree is created — while the branch is still level with its base — and
  /// stays mounted for the life of the session panel. Seeding the fields from state initializers
  /// froze that first moment, so the title was whatever `main` last committed and no amount of
  /// work by the agent afterwards changed it.
  it("takes the newest commit subject each time it is opened", () => {
    const { rerender } = render(
      <OpenPullRequestDialog
        {...props({ open: false, lastCommitSubject: "Add the review queue" })}
      />,
    );

    rerender(
      <OpenPullRequestDialog
        {...props({ open: true, lastCommitSubject: "Fix the review queue" })}
      />,
    );

    expect(title().value).toBe("Fix the review queue");
  });

  /// A branch with no commit of its own has no sentence to offer, and the slug is better than the
  /// base branch's last commit message.
  it("falls back to the branch name when there is no commit to name it after", () => {
    render(<OpenPullRequestDialog {...props({ lastCommitSubject: null })} />);

    expect(title().value).toBe("maestro/great-lynx-58");
  });

  /// The worktrees behind these props refetch every ten seconds. Re-seeding on anything but `open`
  /// would rewrite the field under whoever was typing in it.
  it("leaves a title being edited alone when the worktree poll lands", () => {
    const { rerender } = render(
      <OpenPullRequestDialog {...props({ lastCommitSubject: "Add the review queue" })} />,
    );

    fireEvent.change(title(), { target: { value: "Rework the review queue" } });
    rerender(
      <OpenPullRequestDialog
        {...props({ open: true, lastCommitSubject: "Fix the review queue" })}
      />,
    );

    expect(title().value).toBe("Rework the review queue");
  });

  /// `origin/main` is right for branching and never right as a merge target, since no forge has a
  /// branch by that name. Seeded in the same effect as the title, so it regresses the same way.
  it("defaults the target to the base branch without its remote", () => {
    render(<OpenPullRequestDialog {...props({ baseBranch: "origin/main" })} />);

    expect(target().value).toBe("main");
  });
});
