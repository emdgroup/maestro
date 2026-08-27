import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectDefaultsSection } from "./ProjectDefaultsSection";
import type { DiscoveredAgent } from "@/types/bindings";

/// Whether the project is a git repository, swapped per test — the worktree control does not
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

function renderSection(props: { defaultAgent?: string | null; defaultWorktree?: boolean } = {}) {
  const onChange = vi.fn();
  render(
    <ProjectDefaultsSection
      defaultAgent={props.defaultAgent ?? null}
      defaultWorktree={props.defaultWorktree ?? true}
      onChange={onChange}
      agents={agents}
      agentsLoading={false}
      connection={{ type: "local" }}
    />,
  );
  return onChange;
}

describe("ProjectDefaultsSection", () => {
  beforeEach(() => {
    isGitRepo.current = true;
  });

  /// The regression this panel was reported for: the worktree default is written to
  /// `.maestro/settings.json` the moment it is flipped, not when a Save button is pressed —
  /// there no longer is one.
  it("persists the worktree default as soon as it is toggled", async () => {
    const onChange = renderSection({ defaultWorktree: true });

    await userEvent.click(screen.getByRole("switch"));

    expect(onChange).toHaveBeenCalledWith({ default_worktree: false });
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

  /// A non-git project cannot have worktrees at all, so the choice is not offered.
  it("hides the worktree control outside a git repository", () => {
    isGitRepo.current = false;

    renderSection();

    expect(screen.queryByRole("switch")).toBeNull();
  });
});
