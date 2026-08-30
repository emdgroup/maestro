import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NewWorktreeFields } from "./NewWorktreeFields";
import type { WorktreeWithStatus } from "@/types/bindings";

const branches = vi.hoisted(() => ({
  local: ["main", "feature/payments"],
  remote: [] as string[],
}));

/// The picker fetches its own branches through the project store and a query; neither is what
/// these tests are about, so both are replaced by a fixed list.
vi.mock("@/services/task.service", () => ({
  useProjectBranchesQuery: () => ({ data: [branches, "main"], isFetching: false }),
  taskQueryKeys: { base: ["tasks"] },
}));
vi.mock("@/store/projectStore", () => ({ useSelectedProject: () => ({ id: 1, path: "/repo" }) }));

const REPO = "/repo";

function worktree(overrides: Partial<WorktreeWithStatus> = {}): WorktreeWithStatus {
  return {
    id: 1,
    path: "/repo/.maestro/worktrees/session-31",
    branch_name: "feature/payments",
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

/// `BranchPicker` reaches for the query client directly to refresh its branch list, so the tree
/// needs a real provider even though the query itself is mocked out above.
function setup(props: Partial<React.ComponentProps<typeof NewWorktreeFields>> = {}) {
  const handlers = {
    onBranchModeChange: vi.fn(),
    onBranchChange: vi.fn(),
    onBranchSuffixChange: vi.fn(),
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <NewWorktreeFields
        branchMode="Create"
        branch="main"
        branchSuffix=""
        generatedSuffix="42-fix-login"
        worktrees={[]}
        repoPath={REPO}
        {...handlers}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...handlers, unmount: result.unmount };
}

describe("NewWorktreeFields — the mode chip", () => {
  it("reads FROM when creating and ON when checking out", () => {
    const { unmount } = setup();
    expect(screen.getByRole("button", { name: /Creating a new branch/ })).toHaveTextContent("From");
    unmount();

    setup({ branchMode: "Checkout" });
    expect(screen.getByRole("button", { name: /Checking out the branch/ })).toHaveTextContent("On");
  });

  /// The whole point of the chip: both options are named, so the second one is not invisible.
  it("offers both modes by name, ticking the active one", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /Creating a new branch/ }));

    expect(screen.getByRole("menuitem", { name: /Create a new branch/ })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /Check out an existing branch/ }),
    ).toBeInTheDocument();
  });

  it("switches mode when the other option is chosen", async () => {
    const { onBranchModeChange } = setup();
    await userEvent.click(screen.getByRole("button", { name: /Creating a new branch/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Check out an existing branch/ }));

    expect(onBranchModeChange).toHaveBeenCalledWith("Checkout");
  });
});

describe("NewWorktreeFields — the branch name", () => {
  it("locks the maestro/ prefix outside the editable field", () => {
    setup();
    expect(screen.getByLabelText("Branch name")).toHaveValue("");
    expect(screen.getByText("maestro/")).toBeInTheDocument();
    // The prefix is an addon, not part of what the user can type over.
    expect(screen.getByLabelText("Branch name")).not.toHaveValue("maestro/");
  });

  it("previews the generated name as the placeholder", () => {
    setup();
    expect(screen.getByLabelText("Branch name")).toHaveAttribute("placeholder", "42-fix-login");
  });

  it("reports an invalid name", () => {
    setup({ branchSuffix: "has space" });
    expect(screen.getByText(/cannot contain spaces/)).toBeInTheDocument();
  });

  /// Nothing is being created, so there is no name to give.
  it("drops the name field when checking out", () => {
    setup({ branchMode: "Checkout" });
    expect(screen.queryByLabelText("Branch name")).not.toBeInTheDocument();
  });
});

describe("NewWorktreeFields — a branch already checked out", () => {
  beforeEach(() => {
    branches.local = ["main", "feature/payments"];
  });

  it("greys the branch and says who holds it, without hiding it", async () => {
    setup({ branchMode: "Checkout", branch: "", worktrees: [worktree()] });
    await userEvent.click(screen.getByRole("button", { name: "Select branch..." }));

    const row = screen.getByRole("button", { name: /feature\/payments/ });
    expect(row).toBeDisabled();
    expect(row).toHaveTextContent("in use — session-31");
  });

  it("leaves a free branch selectable", async () => {
    const { onBranchChange } = setup({
      branchMode: "Checkout",
      branch: "",
      worktrees: [worktree()],
    });
    await userEvent.click(screen.getByRole("button", { name: "Select branch..." }));
    await userEvent.click(screen.getByRole("button", { name: /^main/ }));

    expect(onBranchChange).toHaveBeenCalledWith("main");
  });

  /// A detached worktree keeps the branch name it was made on but is checked out on nothing.
  it("does not grey a branch a detached worktree merely remembers", async () => {
    setup({
      branchMode: "Checkout",
      branch: "",
      worktrees: [worktree({ detached_at: "a1b2c3d" })],
    });
    await userEvent.click(screen.getByRole("button", { name: "Select branch..." }));

    expect(screen.getByRole("button", { name: /feature\/payments/ })).not.toBeDisabled();
  });

  it("alerts on an already-selected branch and offers both recoveries", async () => {
    const onUseExistingWorkspace = vi.fn();
    const { onBranchModeChange } = setup({
      branchMode: "Checkout",
      branch: "feature/payments",
      worktrees: [worktree()],
      onUseExistingWorkspace,
    });

    expect(screen.getByText(/already checked out in/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Use that workspace" }));
    expect(onUseExistingWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "worktree" }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Create a branch from it" }));
    expect(onBranchModeChange).toHaveBeenCalledWith("Create");
  });

  it("names the repository directory rather than a worktree when the root holds it", () => {
    const onUseExistingWorkspace = vi.fn();
    setup({
      branchMode: "Checkout",
      branch: "main",
      worktrees: [worktree({ id: 2, path: REPO, branch_name: "main" })],
      onUseExistingWorkspace,
    });

    expect(screen.getByText(/is the branch your project directory is on/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Work in the repository directory" }),
    ).toBeInTheDocument();
  });

  /// A dead button is worse than none: the alert explains instead.
  it("withholds the reuse action when the caller says it is unavailable, and says why", () => {
    setup({
      branchMode: "Checkout",
      branch: "feature/payments",
      worktrees: [worktree({ task_id: 9, task_name: "Fix login" })],
      onUseExistingWorkspace: vi.fn(),
      useExistingBlockedReason: () => "That workspace belongs to the task “Fix login”.",
    });

    expect(screen.queryByRole("button", { name: "Use that workspace" })).not.toBeInTheDocument();
    expect(screen.getByText(/belongs to the task/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a branch from it" })).toBeInTheDocument();
  });

  /// The Workspaces view passes no callback at all — it has no workspace to fall back to.
  it("offers only the branch recovery when no reuse handler is given", () => {
    setup({ branchMode: "Checkout", branch: "feature/payments", worktrees: [worktree()] });

    expect(screen.queryByRole("button", { name: "Use that workspace" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a branch from it" })).toBeInTheDocument();
  });

  /// Creating a branch makes a new ref, which by definition no worktree is on.
  it("says nothing about conflicts while creating a branch", () => {
    setup({ branchMode: "Create", branch: "feature/payments", worktrees: [worktree()] });
    expect(screen.queryByText(/already checked out/)).not.toBeInTheDocument();
  });
});
