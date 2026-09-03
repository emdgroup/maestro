import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

vi.mock("@/utils/hooks/useResolveWorktree", () => ({
  useResolveWorktree: () => ({ resolveWorktree: vi.fn(), isCreatingWorktree: false }),
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
  /// The Worktrees panel opens this dialog already knowing the branch, and the branch is the whole
  /// point of the action — a session started on the project default instead of the pull request's
  /// branch is on the wrong code, silently.
  ///
  /// This regressed on the interaction between two effects rather than on either one: the reset
  /// applies the seed, then the "fill the default in if branches loaded late" effect ran in the
  /// same commit still holding the empty `baseBranch` its render had captured, and overwrote it.
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

  /// The other half of the same effect: with nothing seeded it still has to supply the default,
  /// which is what it was there for in the first place.
  it("still falls back to the project default when nothing is seeded", async () => {
    renderDialog();
    expect(await screen.findByText("main")).toBeInTheDocument();
  });
});
