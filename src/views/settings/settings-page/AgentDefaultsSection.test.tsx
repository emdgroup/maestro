import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentDefaultsSection } from "./AgentDefaultsSection";
import type { DiscoveredAgent } from "@/types/bindings";

vi.mock("@/services/acp-auth.service", () => ({
  useAgentAuthInfoQuery: () => ({ data: { authenticated: false, supportsLogout: false } }),
  useAcpLogoutMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

const agents = [
  { id: "claude-acp", name: "Claude" },
  { id: "codex", name: "Codex" },
] as DiscoveredAgent[];

function renderSection(props: { defaultAgent?: string | null } = {}) {
  const onChange = vi.fn();
  render(
    <AgentDefaultsSection
      defaultAgent={props.defaultAgent ?? null}
      onChange={onChange}
      agents={agents}
      agentsLoading={false}
      connection={{ type: "local" }}
    />,
  );
  return onChange;
}

describe("AgentDefaultsSection", () => {
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
  /// mark, so the summary line underneath is the only thing still reporting what is stored,
  /// and it is what tasks will go on using.
  it("still names a default agent that is not installed", () => {
    renderSection({ defaultAgent: "goose" });

    expect(screen.getByText(/goose runs new sessions/i)).toBeTruthy();
  });

  /// The summary has to say what the default decides, and what its absence means. It used to
  /// claim that without one "tasks use the session's own agent" — they have none, and refused
  /// to start, which is how a new project looked broken with the explanation two pages away.
  it("says the default also runs task stages that have no profile", () => {
    renderSection({ defaultAgent: "claude-acp" });

    expect(screen.getByText(/any task stage with no profile of its own/i)).toBeTruthy();
  });

  /// Reachable only when discovery found nothing, since a project with agents installed is given
  /// one automatically. So the empty line names that cause rather than a setting to go and change.
  it("blames the missing installation when there is no default", () => {
    renderSection({ defaultAgent: null });

    expect(screen.getByText(/no agent is installed on this project's connection/i)).toBeTruthy();
  });
});
