import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GitSection } from "./GitSection";
import { visiblePages } from "./settings-registry";
import type { WorkspaceMode } from "@/types/bindings";

const branches = vi.hoisted(() => ({
  local: ["main", "develop"],
  remote: ["origin/main"],
}));

/// Only for `BranchPicker`, which resolves the project id it queries from the store.
vi.mock("@/store/projectStore", () => ({
  useSelectedProject: () => ({ id: 1, path: "/repo" }),
}));

vi.mock("@/services/task.service", () => ({
  useProjectBranchesQuery: () => ({ data: [branches, "main"], isFetching: false }),
  taskQueryKeys: { base: ["tasks"] },
}));

function renderSection(
  props: {
    defaultWorkspaceMode?: WorkspaceMode;
    baseBranch?: string | null;
  } = {},
) {
  const onChange = vi.fn();
  // `BranchPicker` reaches for the query client directly to refresh its branch list, so the tree
  // needs a real provider even though the query itself is mocked out above.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <GitSection
        defaultWorkspaceMode={props.defaultWorkspaceMode ?? "NewWorktree"}
        baseBranch={props.baseBranch ?? null}
        projectId={1}
        onChange={onChange}
      />
    </QueryClientProvider>,
  );
  return onChange;
}

const workspaceSelect = () => screen.getByRole("combobox", { name: /default workspace/i });

describe("GitSection", () => {
  /// The regression this panel was reported for: the workspace default is written to
  /// `.maestro/settings.json` the moment it is picked, not when a Save button is pressed.
  /// There no longer is one.
  it("persists the workspace default as soon as it is picked", async () => {
    const onChange = renderSection({ defaultWorkspaceMode: "NewWorktree" });

    await userEvent.click(workspaceSelect());
    await userEvent.click(await screen.findByRole("option", { name: /repository directory/i }));

    expect(onChange).toHaveBeenCalledWith({ default_workspace_mode: "RepositoryDirectory" });
  });

  /// A project default cannot name a specific workspace, so the third mode is not offered here.
  it("does not offer reusing a workspace as a project default", async () => {
    renderSection();

    await userEvent.click(workspaceSelect());

    expect(screen.queryByRole("option", { name: /reuse an existing workspace/i })).toBeNull();
  });

  it("persists a base branch picked from the list", async () => {
    const onChange = renderSection();

    await userEvent.click(screen.getByRole("button", { name: /auto/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^develop$/ }));

    expect(onChange).toHaveBeenCalledWith({ base_branch: "develop" });
  });

  /// "Auto" is the absence of a choice, so it has to be stored as null rather than as the name of
  /// whichever branch the repository happened to be on when it was picked.
  it("stores auto as no branch at all", async () => {
    const onChange = renderSection({ baseBranch: "develop" });

    await userEvent.click(screen.getByRole("button", { name: /develop/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^Auto/ }));

    expect(onChange).toHaveBeenCalledWith({ base_branch: null });
  });
});

/// The page itself is gated, not just its contents. A project with no git has no worktrees, no
/// base branch and no remote, so a Git entry in the sidebar would lead to an empty card.
describe("the Git page's place in the sidebar", () => {
  it("is offered to a git project", () => {
    const ids = visiblePages({ inProject: true, isGitRepo: true }).map((p) => p.id);

    expect(ids).toContain("git");
  });

  it("is absent from a project that is not a git repository", () => {
    const ids = visiblePages({ inProject: true, isGitRepo: false }).map((p) => p.id);

    expect(ids).not.toContain("git");
    // The rest of the project's settings still apply, so only this one goes.
    expect(ids).toContain("agents");
  });

  /// The welcome screen has no project at all, so it never reaches the git question.
  it("is absent from the welcome screen whatever the flag says", () => {
    const ids = visiblePages({ inProject: false, isGitRepo: true }).map((p) => p.id);

    expect(ids).not.toContain("git");
    expect(ids).not.toContain("agents");
  });
});
