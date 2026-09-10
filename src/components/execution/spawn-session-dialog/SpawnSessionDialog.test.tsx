import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorktreeWithStatus } from "@/types/bindings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("@/services/execution.service", () => ({
  // A real agent, so the dialog does not fall back to a terminal session — which forces the
  // repository directory and hides the branch picker entirely.
  useAgentDiscoveryQuery: () => ({
    data: { agents: [{ id: "claude-acp", name: "Claude", spawn_deps: [] }] },
    isLoading: false,
  }),
  useSpawnAcpSessionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useSpawnInteractiveExecutionMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/services/project.service", () => ({
  useProjectSettings: () => ({
    data: { default_workspace_mode: "NewWorktree", default_agent: "claude-acp" },
  }),
}));

vi.mock("@/services/task.service", () => ({
  useProjectBranchesQuery: () => ({
    data: [{ local: ["main"], remote: ["origin/main", "origin/maestro/great-lynx-58"] }, "main"],
    isFetching: false,
  }),
}));

// The project's default. Non-empty is the whole point: it is what used to overwrite the seed.
vi.mock("@/hooks/useDefaultBaseBranch", () => ({ useDefaultBaseBranch: () => "main" }));

const resolveWorktree = vi.hoisted(() =>
  vi.fn(async () => ({
    cwd: "C:/repo/.maestro/worktrees/session-9",
    branchName: "pr-412",
    created: { id: 9, path: "C:/repo/.maestro/worktrees/session-9", branchName: "pr-412" },
  })),
);

vi.mock("@/hooks/useResolveWorktree", () => ({
  useResolveWorktree: () => ({ resolveWorktree, isCreatingWorktree: false }),
}));

vi.mock("@/store/configStore", () => ({ usePreflightToolChecks: () => [] }));

vi.mock("@/store/projectStore", () => ({
  useIsGitRepo: () => true,
  useSelectedProject: () => ({ id: 1, path: "C:/repo" }),
}));

const { SpawnSessionDialog } = await import("./SpawnSessionDialog");

function worktree(): WorktreeWithStatus {
  return {
    id: 7,
    project_id: 1,
    task_id: null,
    branch_name: "maestro/other-42",
    path: "C:/repo/.maestro/worktrees/session-42",
    changed_files_count: 0,
    created_at: null,
    task_name: null,
    is_zombie: false,
    is_orphan: false,
    diff_stat: null,
    base_branch: "origin/main",
    ahead_behind: { ahead: 0, behind: 0 },
    commit_count: 0,
    last_activity_at: null,
    last_commit_subject: null,
    detached_at: null,
    head_sha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
    upstream_gone: false,
  };
}

function renderDialog(seed?: Parameters<typeof SpawnSessionDialog>[0]["seed"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SpawnSessionDialog
        open
        onOpenChange={vi.fn()}
        projectId={1}
        repoPath="C:/repo"
        connection={{ type: "local" }}
        worktrees={[worktree()]}
        onSuccess={vi.fn()}
        seed={seed}
      />
    </QueryClientProvider>,
  );
}

describe("SpawnSessionDialog seeding", () => {
  /**
   * The Worktrees panel opens this dialog already knowing the branch, and the branch is the whole
   * point of the action — a session started on the project default instead of the pull request's
   * branch is on the wrong code, silently.
   *
   * This regressed on the interaction between two effects rather than on either one: the reset
   * applies the seed, then the "fill the default in if branches loaded late" effect ran in the
   * same commit still holding the empty `baseBranch` its render had captured, and overwrote it.
   */
  it("keeps the seeded branch rather than the project default", async () => {
    renderDialog({
      workspaceMode: "NewWorktree",
      branchMode: "Checkout",
      baseBranch: "origin/maestro/great-lynx-58",
      sessionName: "Ship it",
    });

    expect(await screen.findByText("origin/maestro/great-lynx-58")).toBeInTheDocument();
    expect(screen.queryByText("main")).not.toBeInTheDocument();
  });

  /**
   * The other half of the same effect: with nothing seeded it still has to supply the default,
   * which is what it was there for in the first place.
   */
  it("still falls back to the project default when nothing is seeded", async () => {
    renderDialog();
    expect(await screen.findByText("main")).toBeInTheDocument();
  });

  /**
   * A fork's pull request has no branch on the remote, so the picker has nothing to offer and is
   * replaced by a line naming what will be checked out. Leaving the picker up would show an
   * editable ref that does not resolve, and let the user "correct" it into a failed checkout.
   */
  it("replaces the branch picker with the pull request when one is seeded", async () => {
    renderDialog({
      workspaceMode: "NewWorktree",
      branchMode: "Checkout",
      baseBranch: "main",
      pullRequestNumber: 412,
      headBranch: "patch-1",
      sessionName: "Review the fork",
    });

    expect(await screen.findByText(/#412 · patch-1/)).toBeInTheDocument();
    expect(screen.getByText(/A new worktree on pr-412/)).toBeInTheDocument();
    // No branch picker, so the project default it would have shown is nowhere on screen.
    expect(screen.queryByText("main")).not.toBeInTheDocument();
  });

  /**
   * The number is what makes the difference between fetching the forge's ref and checking out
   * `origin/<head_branch>` — which for a fork is either nothing or somebody else's branch. Losing
   * it between the panel and the backend is the original bug, one layer further down.
   */
  it("hands the pull request number to the worktree it creates", async () => {
    resolveWorktree.mockClear();
    renderDialog({
      workspaceMode: "NewWorktree",
      branchMode: "Checkout",
      baseBranch: "main",
      pullRequestNumber: 412,
      headBranch: "patch-1",
      sessionName: "Review the fork",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Start Session" }));

    await waitFor(() => expect(resolveWorktree).toHaveBeenCalled());
    expect(resolveWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequest: 412,
        // Recorded on the row and counted against, not checked out.
        baseBranch: "main",
        // The backend names the branch `pr-412`; asking for one here would be a second answer.
        newBranchName: null,
      }),
    );
  });

  /**
   * The same call without a seed must carry no number, or every ordinary session would be routed
   * through the pull request path.
   */
  it("sends no pull request when the dialog was not seeded with one", async () => {
    resolveWorktree.mockClear();
    renderDialog({
      workspaceMode: "NewWorktree",
      branchMode: "Checkout",
      baseBranch: "origin/maestro/great-lynx-58",
      sessionName: "Ship it",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Start Session" }));

    await waitFor(() => expect(resolveWorktree).toHaveBeenCalled());
    expect(resolveWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ pullRequest: null, baseBranch: "origin/maestro/great-lynx-58" }),
    );
  });
});
