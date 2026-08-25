import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentProfilesSection, type AgentProfilesSectionHandle } from "./AgentProfilesSection";
import type { ProfilesDocument } from "@/types/bindings";

/// What `.maestro/profiles.json` currently holds, swapped per test.
const stored = vi.hoisted(() => ({ current: { profiles: [], defaults: {} } as ProfilesDocument }));
const save = vi.hoisted(() => vi.fn());

vi.mock("@/services/project.service", () => ({
  useAgentProfilesQuery: () => ({ data: stored.current }),
  useSaveAgentProfilesMutation: () => ({ mutateAsync: save }),
}));

const agents = [
  { id: "claude-acp", name: "Claude" },
  { id: "codex", name: "Codex" },
];

function renderSection() {
  const ref = createRef<AgentProfilesSectionHandle>();
  render(<AgentProfilesSection ref={ref} projectId={1} agents={agents} />);
  return ref;
}

describe("AgentProfilesSection", () => {
  beforeEach(() => {
    save.mockReset();
    stored.current = { profiles: [], defaults: {} };
  });

  /// The panel exists because this file had to be edited by hand — `list_agent_profiles` and
  /// `save_agent_profiles` shipped with no caller in the UI at all.
  it("saves what the project already had, unchanged", async () => {
    stored.current = {
      profiles: [
        {
          id: "r1",
          name: "Strict reviewer",
          role: "Reviewer",
          agent_id: "claude-acp",
          skills: [],
          mcp_servers: [],
          fallback_behaviour: "Warn",
        },
      ],
      defaults: { Reviewer: "r1" },
    };

    const ref = renderSection();
    await ref.current!.save();

    expect(save).toHaveBeenCalledWith({
      projectId: 1,
      document: { profiles: stored.current.profiles, defaults: { Reviewer: "r1" } },
    });
  });

  /// A `profiles.json` that has never been written arrives with both fields undefined, because
  /// both are `#[serde(default)]`. Rendering that must not throw, and saving it must not send
  /// `undefined` back as the whole document.
  it("survives a project with no profiles file yet", async () => {
    stored.current = {};

    const ref = renderSection();
    await ref.current!.save();

    expect(save).toHaveBeenCalledWith({ projectId: 1, document: { profiles: [], defaults: {} } });
    expect(screen.getAllByText("No profile — stage skipped.")).toHaveLength(4);
  });

  /// The first profile for a role becomes its default. A role with profiles and no default
  /// resolves to "the first one declaring the role" in Rust anyway, so leaving it unset would
  /// mean the panel showed no selection for a choice that had in fact been made.
  it("makes the first profile of a role its default", async () => {
    const ref = renderSection();

    await userEvent.click(screen.getByRole("button", { name: "Add a Refinement profile" }));
    await ref.current!.save();

    const document = save.mock.calls[0]![0].document as ProfilesDocument;
    expect(document.profiles).toHaveLength(1);
    expect(document.profiles![0]!.role).toBe("Refiner");
    expect(document.defaults!.Refiner).toBe(document.profiles![0]!.id);
  });

  /// Removing the default has to hand the role to another profile rather than leaving `defaults`
  /// pointing at something that no longer exists.
  it("moves a role's default off a profile that is deleted", async () => {
    stored.current = {
      profiles: [
        {
          id: "c1",
          name: "First",
          role: "Coder",
          agent_id: "claude-acp",
          skills: [],
          mcp_servers: [],
          fallback_behaviour: "Warn",
        },
        {
          id: "c2",
          name: "Second",
          role: "Coder",
          agent_id: "codex",
          skills: [],
          mcp_servers: [],
          fallback_behaviour: "Warn",
        },
      ],
      defaults: { Coder: "c1" },
    };

    const ref = renderSection();
    await userEvent.click(screen.getByRole("button", { name: "Remove First" }));
    await ref.current!.save();

    const document = save.mock.calls[0]![0].document as ProfilesDocument;
    expect(document.profiles!.map((p) => p.id)).toEqual(["c2"]);
    expect(document.defaults!.Coder).toBe("c2");
  });
});
