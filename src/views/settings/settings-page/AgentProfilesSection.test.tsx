import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentProfilesSection } from "./AgentProfilesSection";
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
  useSaveAgentProfilesMutation: () => ({ mutate: save }),
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
  render(<AgentProfilesSection projectId={1} agents={agents} connection={{ type: "local" }} />);
}

/// The document handed to the most recent write.
function lastSaved(): ProfilesDocument {
  const calls = save.mock.calls;
  return calls[calls.length - 1]![0].document as ProfilesDocument;
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

  /// There is no Save button, so the panel writes on every change — which makes "did not change
  /// anything" the case worth pinning down. Adopting the project's own document must not write it
  /// straight back, or every visit to Settings would touch a file the whole team shares.
  it("writes nothing when the user changes nothing", async () => {
    stored.current = oneCoder("opus");

    renderSection();
    // Focus and leave the name field: blur is what commits a text edit, and tabbing through a
    // form is not an edit.
    await userEvent.click(screen.getByDisplayValue("Coder"));
    await userEvent.tab();

    expect(save).not.toHaveBeenCalled();
  });

  /// A `profiles.json` that has never been written arrives with both fields undefined, because
  /// both are `#[serde(default)]`. Rendering that must not throw, and the first write must not
  /// send `undefined` back as the whole document.
  it("survives a project with no profiles file yet", async () => {
    stored.current = {};

    renderSection();
    expect(screen.getAllByText("No profile — stage skipped.")).toHaveLength(4);

    await userEvent.click(screen.getByRole("button", { name: "Add a Refinement profile" }));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].projectId).toBe(1);
    expect(lastSaved().profiles).toHaveLength(1);
  });

  /// The first profile for a role becomes its default. A role with profiles and no default
  /// resolves to "the first one declaring the role" in Rust anyway, so leaving it unset would
  /// mean the panel showed no selection for a choice that had in fact been made.
  it("makes the first profile of a role its default", async () => {
    renderSection();

    await userEvent.click(screen.getByRole("button", { name: "Add a Refinement profile" }));

    const document = lastSaved();
    expect(document.profiles).toHaveLength(1);
    expect(document.profiles![0]!.role).toBe("Refiner");
    expect(document.defaults!.Refiner).toBe(document.profiles![0]!.id);
  });

  /// The prompt is the field that makes a profile worth having, and a blank box is why most
  /// profiles never get one. Asserted as "non-empty and different per role" rather than against
  /// the shipped wording, which is meant to be rewritten without breaking a test.
  it("prefills a new profile's instructions with its role's template", async () => {
    renderSection();

    await userEvent.click(screen.getByRole("button", { name: "Add a Review profile" }));
    await userEvent.click(screen.getByRole("button", { name: "Add a Implementation profile" }));

    const [reviewer, coder] = lastSaved().profiles!;
    expect(reviewer!.role_prompt).toBeTruthy();
    expect(coder!.role_prompt).toBeTruthy();
    expect(coder!.role_prompt).not.toBe(reviewer!.role_prompt);
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

    renderSection();
    await userEvent.click(screen.getByRole("button", { name: "Remove First" }));

    const document = lastSaved();
    expect(document.profiles!.map((p) => p.id)).toEqual(["c2"]);
    expect(document.defaults!.Coder).toBe("c2");
  });

  /// A rename is a text edit, so it lands on blur rather than on each keystroke.
  it("saves a renamed profile when the field loses focus", async () => {
    stored.current = oneCoder(null);

    renderSection();
    await userEvent.type(screen.getByDisplayValue("Coder"), "!");
    expect(save).not.toHaveBeenCalled();

    await userEvent.tab();

    expect(lastSaved().profiles![0]!.name).toBe("Coder!");
  });

  /// The model was a free-text box, which is why this became a list at all. The list comes from
  /// asking the agent, so it is only as good as the machine doing the asking.
  ///
  /// Asserted through the trigger's label rather than an `<option>` list: this is a base-ui Select,
  /// which renders a button and portals its items only while open, so the visible label is both the
  /// only thing present when closed and the thing the user actually reads.
  it("names the chosen model on the trigger", () => {
    stored.current = oneCoder("opus");
    probe.current = {
      data: [
        { model_id: "sonnet", name: "Sonnet" },
        { model_id: "opus", name: "Opus" },
      ],
      isLoading: false,
      isError: false,
    };

    renderSection();

    expect(screen.getByRole("combobox", { name: "Model for Coder" })).toHaveTextContent("Opus");
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

    expect(screen.getByRole("combobox", { name: "Model for Coder" })).toHaveTextContent(
      "gpt-5-codex (not offered)",
    );
  });

  /// A probe that failed and an agent that genuinely has one model both come back empty, and the
  /// difference matters: one means "nothing to choose", the other means "we could not ask".
  it("says when it could not ask the agent", () => {
    stored.current = oneCoder(null);
    probe.current = { data: undefined as never, isLoading: false, isError: true };

    renderSection();

    expect(screen.getByRole("combobox", { name: "Model for Coder" })).toHaveTextContent(
      "agent default (could not ask)",
    );
  });
});
