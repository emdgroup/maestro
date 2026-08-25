import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentProfilesSection, type AgentProfilesSectionHandle } from "./AgentProfilesSection";
import type { ProfilesDocument } from "@/types/bindings";

/// What `.maestro/profiles.json` currently holds, swapped per test.
const stored = vi.hoisted(() => ({ current: { profiles: [], defaults: {} } as ProfilesDocument }));
const save = vi.hoisted(() => vi.fn());
/// What the model probe came back with. Mocked rather than exercised: the real one spawns an
/// agent subprocess, which is not something a unit test should be doing.
const probe = vi.hoisted(() => ({
  current: {
    data: [] as Array<{ model_id: string; name: string }>,
    isLoading: false,
    isError: false,
  },
}));

vi.mock("@/services/project.service", () => ({
  useAgentProfilesQuery: () => ({ data: stored.current }),
  useSaveAgentProfilesMutation: () => ({ mutateAsync: save }),
}));

vi.mock("@/services/execution.service", () => ({
  useAgentModelsQuery: () => probe.current,
}));

vi.mock("@/store/projectStore", () => ({
  useSelectedProject: () => ({ id: 1, path: "/repo" }),
}));

const agents = [
  { id: "claude-acp", name: "Claude" },
  { id: "codex", name: "Codex" },
];

function renderSection() {
  const ref = createRef<AgentProfilesSectionHandle>();
  render(
    <AgentProfilesSection ref={ref} projectId={1} agents={agents} connection={{ type: "local" }} />,
  );
  return ref;
}

const oneCoder = (model: string | null): ProfilesDocument => ({
  profiles: [
    {
      id: "c1",
      name: "Coder",
      role: "Coder",
      agent_id: "claude-acp",
      model,
      skills: [],
      mcp_servers: [],
      fallback_behaviour: "Warn",
    },
  ],
  defaults: { Coder: "c1" },
});

describe("AgentProfilesSection", () => {
  beforeEach(() => {
    save.mockReset();
    stored.current = { profiles: [], defaults: {} };
    probe.current = { data: [], isLoading: false, isError: false };
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

  /// The model was a free-text box, which is why this became a list at all. The list comes from
  /// asking the agent, so it is only as good as the machine doing the asking.
  it("offers the models the agent reported", () => {
    stored.current = oneCoder(null);
    probe.current = {
      data: [
        { model_id: "sonnet", name: "Sonnet" },
        { model_id: "opus", name: "Opus" },
      ],
      isLoading: false,
      isError: false,
    };

    renderSection();

    const select = screen.getByRole("combobox", { name: "Model for Coder" });
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "agent default",
      "Sonnet",
      "Opus",
    ]);
  });

  /// The failure that turning a text box into a list invites: the stored value silently vanishing
  /// because this machine could not confirm it. A profile is the team's choice, committed to the
  /// repository — an agent that is unreachable here, or an account without that model, must not
  /// rewrite it to "agent default" behind the user's back.
  it("keeps a stored model the agent did not offer", () => {
    stored.current = oneCoder("gpt-5-codex");
    probe.current = {
      data: [{ model_id: "sonnet", name: "Sonnet" }],
      isLoading: false,
      isError: false,
    };

    renderSection();

    const select = screen.getByRole("combobox", { name: "Model for Coder" }) as HTMLSelectElement;
    expect(select.value).toBe("gpt-5-codex");
    expect(screen.getByRole("option", { name: "gpt-5-codex (not offered)" })).toBeInTheDocument();
  });

  /// A probe that failed and an agent that genuinely has one model both come back empty, and the
  /// difference matters: one means "nothing to choose", the other means "we could not ask".
  it("says when it could not ask the agent", () => {
    stored.current = oneCoder(null);
    probe.current = { data: undefined as never, isLoading: false, isError: true };

    renderSection();

    expect(
      screen.getByRole("option", { name: "agent default (could not ask)" }),
    ).toBeInTheDocument();
  });
});
