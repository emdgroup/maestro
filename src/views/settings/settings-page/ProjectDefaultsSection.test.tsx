import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectDefaultsSection } from "./ProjectDefaultsSection";
import type { DiscoveredAgent, WorkspaceMode } from "@/types/bindings";

/// Whether the project is a git repository, swapped per test — the workspace control does not
/// exist for a project that cannot have worktrees.
const isGitRepo = vi.hoisted(() => ({ current: true }));

vi.mock("@/services/acp-auth.service", () => ({
  useAgentAuthInfoQuery: () => ({ data: { authenticated: false, supportsLogout: false } }),
  useAcpLogoutMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/store/projectStore", () => ({
  useIsGitRepo: () => isGitRepo.current,
}));

const agents = [
  { id: "claude-acp", name: "Claude" },
  { id: "codex", name: "Codex" },
] as DiscoveredAgent[];

function renderSection(
  props: { defaultAgent?: string | null; defaultWorkspaceMode?: WorkspaceMode } = {},
) {
  const onChange = vi.fn();
  render(
    <ProjectDefaultsSection
      defaultAgent={props.defaultAgent ?? null}
      defaultWorkspaceMode={props.defaultWorkspaceMode ?? "NewWorktree"}
      onChange={onChange}
      agents={agents}
      agentsLoading={false}
      connection={{ type: "local" }}
    />,
  );
  return onChange;
}

const workspaceSelect = () => screen.getByRole("combobox", { name: /default workspace/i });

describe("ProjectDefaultsSection", () => {
  beforeEach(() => {
    isGitRepo.current = true;
  });

  /// The regression this panel was reported for: the workspace default is written to
  /// `.maestro/settings.json` the moment it is picked, not when a Save button is pressed —
  /// there no longer is one.
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

  it("persists the default agent as soon as a row is clicked", async () => {
    const onChange = renderSection({ defaultAgent: "claude-acp" });

    await userEvent.click(screen.getByText("Codex"));

    expect(onChange).toHaveBeenCalledWith({ default_agent: "codex" });
  });

  /// Clicking the row that is already the default is not a change, so it must not write.
  it("does not rewrite the agent that is already the default", async () => {
    const onChange = renderSection({ defaultAgent: "claude-acp" });

    await userEvent.click(screen.getByText("Claude"));

    expect(onChange).not.toHaveBeenCalled();
  });

  /// A default naming an agent that is no longer installed on this connection has no row to
  /// mark, so the summary line underneath is the only thing still reporting what is stored —
  /// and it is what tasks will go on using.
  it("still names a default agent that is not installed", () => {
    renderSection({ defaultAgent: "goose" });

    expect(screen.getByText(/goose is used for new sessions/i)).toBeTruthy();
  });

  /// A non-git project cannot have worktrees at all, so the choice is not offered.
  it("hides the workspace control outside a git repository", () => {
    isGitRepo.current = false;

    renderSection();

    expect(screen.queryByRole("combobox", { name: /default workspace/i })).toBeNull();
  });
});
