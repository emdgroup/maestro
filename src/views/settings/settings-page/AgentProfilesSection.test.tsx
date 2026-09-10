import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentProfilesSection } from "./AgentProfilesSection";
import type { ProfilesDocument } from "@/types/bindings";

/** What `.maestro/profiles.json` currently holds, swapped per test. */
const stored = vi.hoisted(() => ({ current: { profiles: [], defaults: {} } as ProfilesDocument }));
const save = vi.hoisted(() => vi.fn());
/**
 * What the agent probe came back with. Mocked rather than exercised: the real one spawns an
 * agent subprocess, which is not something a unit test should be doing.
 */
const probe = vi.hoisted(() => ({
  current: {
    data: { models: [], modes: [], effort: null } as {
      models: Array<{ model_id: string; name: string }>;
      modes: Array<{ mode_id: string; name: string }>;
      effort: { option_id: string; values: Array<{ value: string; name: string }> } | null;
    },
    isLoading: false,
    // The three states are not derivable from each other, which is the point: a query whose key
    // has just changed is neither loading nor answered, and that gap is what the resets must not
    // act in. Set them the way TanStack would rather than inferring one from another.
    isSuccess: true,
    isError: false,
  },
}));

vi.mock("@/services/project.service", () => ({
  useAgentProfilesQuery: () => ({ data: stored.current }),
  useSaveAgentProfilesMutation: () => ({ mutate: save }),
}));

/**
 * The probe's arguments, so the tests can assert that the model a profile names is what gets
 * asked about — the whole reason the effort list is trustworthy.
 */
const probeArgs = vi.hoisted(() => vi.fn());

vi.mock("@/services/execution.service", () => ({
  useAgentConfigQuery: (
    agentId: string | null,
    cwd: string | null,
    projectId: number | null,
    connection: unknown,
    modelId: string | null,
    enabled: boolean,
  ) => {
    probeArgs({ agentId, cwd, projectId, connection, modelId, enabled });
    return probe.current;
  },
}));

vi.mock("@/store/projectStore", () => ({
  useSelectedProject: () => ({ id: 1, path: "/repo" }),
}));

const agents = [
  { id: "claude-acp", name: "Claude" },
  { id: "codex", name: "Codex" },
];

function renderSection() {
  return render(
    <AgentProfilesSection projectId={1} agents={agents} connection={{ type: "local" }} />,
  );
}

/** The same element again, for a rerender that swaps what the probe is reporting. */
const section = (
  <AgentProfilesSection projectId={1} agents={agents} connection={{ type: "local" }} />
);

/** The document handed to the most recent write. */
function lastSaved(): ProfilesDocument {
  const calls = save.mock.calls;
  return calls[calls.length - 1]![0].document as ProfilesDocument;
}

const oneCoder = (
  model: string | null,
  permissionMode: string | null = null,
  effort: string | null = null,
): ProfilesDocument => ({
  profiles: [
    {
      id: "c1",
      name: "Coder",
      role: "Coder",
      agent_id: "claude-acp",
      model,
      effort,
      permission_mode: permissionMode,
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
    probeArgs.mockReset();
    stored.current = { profiles: [], defaults: {} };
    probe.current = {
      data: { models: [], modes: [], effort: null },
      isLoading: false,
      isSuccess: true,
      isError: false,
    };
  });

  /**
   * There is no Save button, so the panel writes on every change — which makes "did not change
   * anything" the case worth pinning down. Adopting the project's own document must not write it
   * straight back, or every visit to Settings would touch a file the whole team shares.
   */
  it("writes nothing when the user changes nothing", async () => {
    stored.current = oneCoder("opus");
    // Confirmed by the probe, so none of the reset effects have anything to do — an unconfirmable
    // value is a change, and is covered by its own tests below.
    probe.current = {
      data: { models: [{ model_id: "opus", name: "Opus" }], modes: [], effort: null },
      isLoading: false,
      isSuccess: true,
      isError: false,
    };

    renderSection();
    // Focus and leave the name field: blur is what commits a text edit, and tabbing through a
    // form is not an edit.
    await userEvent.click(screen.getByDisplayValue("Coder"));
    await userEvent.tab();

    expect(save).not.toHaveBeenCalled();
  });

  /**
   * A `profiles.json` that has never been written arrives with both fields undefined, because
   * both are `#[serde(default)]`. Rendering that must not throw, and the first write must not
   * send `undefined` back as the whole document.
   */
  it("survives a project with no profiles file yet", async () => {
    stored.current = {};

    renderSection();
    // Three, not four: Implementation is the one role that still runs without a profile, on the
    // project's default agent, and saying it is skipped is what sent users looking for a profile
    // they did not need.
    expect(screen.getAllByText("No profile — stage skipped.")).toHaveLength(3);
    expect(
      screen.getByText("No profile — runs on the project's default agent."),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add a Refinement profile" }));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].projectId).toBe(1);
    expect(lastSaved().profiles).toHaveLength(1);
  });

  /**
   * The first profile for a role becomes its default. A role with profiles and no default
   * resolves to "the first one declaring the role" in Rust anyway, so leaving it unset would
   * mean the panel showed no selection for a choice that had in fact been made.
   */
  it("makes the first profile of a role its default", async () => {
    renderSection();

    await userEvent.click(screen.getByRole("button", { name: "Add a Refinement profile" }));

    const document = lastSaved();
    expect(document.profiles).toHaveLength(1);
    expect(document.profiles![0]!.role).toBe("Refiner");
    expect(document.defaults!.Refiner).toBe(document.profiles![0]!.id);
  });

  /**
   * The prompt is the field that makes a profile worth having, and a blank box is why most
   * profiles never get one. Asserted as "non-empty and different per role" rather than against
   * the shipped wording, which is meant to be rewritten without breaking a test.
   */
  it("prefills a new profile's instructions with its role's template", async () => {
    renderSection();

    await userEvent.click(screen.getByRole("button", { name: "Add a Review profile" }));
    await userEvent.click(screen.getByRole("button", { name: "Add a Implementation profile" }));

    const [reviewer, coder] = lastSaved().profiles!;
    expect(reviewer!.role_prompt).toBeTruthy();
    expect(coder!.role_prompt).toBeTruthy();
    expect(coder!.role_prompt).not.toBe(reviewer!.role_prompt);
  });

  /**
   * Removing the default has to hand the role to another profile rather than leaving `defaults`
   * pointing at something that no longer exists.
   */
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

  /** A rename is a text edit, so it lands on blur rather than on each keystroke. */
  it("saves a renamed profile when the field loses focus", async () => {
    stored.current = oneCoder(null);

    renderSection();
    await userEvent.type(screen.getByDisplayValue("Coder"), "!");
    expect(save).not.toHaveBeenCalled();

    await userEvent.tab();

    expect(lastSaved().profiles![0]!.name).toBe("Coder!");
  });

  /**
   * The model was a free-text box, which is why this became a list at all. The list comes from
   * asking the agent, so it is only as good as the machine doing the asking.
   *
   * Asserted through the trigger's label rather than an `<option>` list: this is a base-ui Select,
   * which renders a button and portals its items only while open, so the visible label is both the
   * only thing present when closed and the thing the user actually reads.
   */
  it("names the chosen model on the trigger", () => {
    stored.current = oneCoder("opus");
    probe.current = {
      data: {
        models: [
          { model_id: "sonnet", name: "Sonnet" },
          { model_id: "opus", name: "Opus" },
        ],
        modes: [],
        effort: null,
      },
      isLoading: false,
      isSuccess: true,
      isError: false,
    };

    renderSection();

    expect(screen.getByRole("combobox", { name: "Model for Coder" })).toHaveTextContent("Opus");
  });

  /**
   * The field must never show a selection the agent does not have. Keeping one and labelling it
   * `(not offered)` read as a choice that had been made, and was not: the spawn path drops a value
   * the agent rejects with a console warning, so the profile said one thing and the run did
   * another. Clearing it to "agent default" is what the run would do anyway.
   */
  it("clears a stored model the agent does not offer", () => {
    stored.current = oneCoder("gpt-5-codex");
    probe.current = {
      data: { models: [{ model_id: "sonnet", name: "Sonnet" }], modes: [], effort: null },
      isLoading: false,
      isSuccess: true,
      isError: false,
    };

    renderSection();

    expect(screen.getByRole("combobox", { name: "Model for Coder" })).toHaveTextContent(
      "agent default",
    );
    // And it lands on disk: a value only cleared on screen would come back on the next visit.
    expect(lastSaved().profiles![0]!.model).toBeNull();
  });

  /**
   * The accepted cost of the rule above, pinned here so it is a decision rather than a surprise.
   * A probe that failed and one that came back empty are indistinguishable from the panel, so an
   * agent that is unreachable *here* — SSH down, spawn timed out — clears the fields of the
   * profiles naming it, for the whole team, since `profiles.json` is committed. The carve-out is
   * the agent being absent entirely, covered below.
   */
  it("clears every unconfirmable field when the probe failed", () => {
    stored.current = oneCoder("opus", "auto", "high");
    probe.current = { data: undefined as never, isLoading: false, isSuccess: false, isError: true };

    renderSection();

    const saved = lastSaved().profiles![0]!;
    expect(saved.model).toBeNull();
    expect(saved.permission_mode).toBeNull();
    expect(saved.effort).toBeNull();
  });

  /**
   * The reset has to wait for an answer. A probe still in flight has the same empty lists as one
   * that failed, and clearing on that would wipe a good value every time the panel opened — or,
   * worse, every time the user changed the model, since that re-probes.
   */
  it("writes nothing while the probe is still running", () => {
    stored.current = oneCoder("opus", "auto", "high");
    probe.current = { data: undefined as never, isLoading: true, isSuccess: false, isError: false };

    renderSection();

    expect(save).not.toHaveBeenCalled();
    // All three go on showing what is stored while the asking happens — the labels are covered by
    // their own tests below; this one is only about not writing.
    expect(screen.getByRole("combobox", { name: "Effort for Coder" })).toHaveTextContent("high");
  });

  /**
   * Changing the model re-probes, and the field that must not go blank for it is the model itself:
   * it is the one answer on the card the user supplied rather than the agent, and the model list
   * is a property of the agent, so nothing a re-probe returns can change it. Blanking it read as
   * the panel asking the agent to confirm a choice it had just been given.
   */
  it("goes on naming the model while a model change re-probes", () => {
    stored.current = oneCoder("opus");
    probe.current = {
      data: {
        models: [
          { model_id: "opus", name: "Opus 4.7" },
          { model_id: "sonnet", name: "Sonnet 4.6" },
        ],
        modes: [],
        effort: null,
      },
      isLoading: false,
      isSuccess: true,
      isError: false,
    };

    const { rerender } = renderSection();
    expect(screen.getByRole("combobox", { name: "Model for Coder" })).toHaveTextContent("Opus 4.7");

    // The new query key has nothing cached, so the probe restarts with no data at all.
    probe.current = { data: undefined as never, isLoading: true, isSuccess: false, isError: false };
    rerender(section);

    // Still the display name, not the raw id and not a spinner message.
    expect(screen.getByRole("combobox", { name: "Model for Coder" })).toHaveTextContent("Opus 4.7");
    // Effort is the field that genuinely does not know yet — it is per-model, so it says so.
    expect(screen.getByRole("combobox", { name: "Effort for Coder" })).toHaveTextContent(
      "asking the agent…",
    );
  });

  /**
   * A model id is only meaningful to the harness that issued it. Carrying one across an agent
   * change made the next probe ask the new agent to select a model it had never heard of, which
   * it answers with an error the user is shown as "Agent failed to start: SetModel failed". The
   * mode and effort go the same way and for the same reason — they are the old agent's.
   */
  it("drops the model, mode and effort when the agent changes", async () => {
    stored.current = oneCoder("opus", "auto", "high");
    probe.current = {
      data: {
        models: [{ model_id: "opus", name: "Opus" }],
        modes: [{ mode_id: "auto", name: "Auto" }],
        effort: { option_id: "reasoningEffort", values: [{ value: "high", name: "High" }] },
      },
      isLoading: false,
      isSuccess: true,
      isError: false,
    };

    renderSection();
    const before = save.mock.calls.length;
    await userEvent.click(screen.getByRole("combobox", { name: "Claude" }));
    await userEvent.click(screen.getByRole("option", { name: "Codex" }));

    // The agent change itself, in one patch — no render in between where the new agent is paired
    // with the old agent's model, which is the state that produced the SetModel error.
    const patched = (save.mock.calls[before]![0].document as ProfilesDocument).profiles![0]!;
    expect(patched.agent_id).toBe("codex");
    expect(patched.model).toBeNull();
    expect(patched.permission_mode).toBeNull();
    expect(patched.effort).toBeNull();

    // The probe of the new agent then asks about no model at all, rather than the old one's, and
    // the mode is filled back in from what *it* offers — a refresh, not a wipe.
    expect(probeArgs).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: "codex", modelId: null }),
    );
    const settled = lastSaved().profiles![0]!;
    expect(settled.permission_mode).toBe("auto");
    expect(settled.model).toBeNull();
    expect(settled.effort).toBeNull();
  });

  /**
   * A query whose key has just changed is neither loading nor answered for a render or two, and
   * `!isLoading` counted that gap as "the agent offers nothing" — so picking a model cleared it
   * back to "agent default" on the very next render. The resets wait for a settled state, not for
   * the absence of a loading one.
   */
  it("keeps a model the user just picked while the re-probe has not answered", () => {
    stored.current = oneCoder("opus");
    probe.current = {
      data: undefined as never,
      isLoading: false,
      isSuccess: false,
      isError: false,
    };

    renderSection();

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Model for Coder" })).toHaveTextContent("opus");
  });

  /**
   * The dropdown has to stay usable across the re-probe its own selection set off. Disabling it
   * mid-interaction had base-ui tear down the open popup and report the value as cleared, which is
   * what made a freshly picked model snap back to "agent default". The list it offers cannot go
   * stale — models are a property of the agent, not of the model in use.
   */
  it("stays selectable while re-probing, off the list it already has", async () => {
    stored.current = oneCoder("opus");
    probe.current = {
      data: {
        models: [
          { model_id: "opus", name: "Opus 4.7" },
          { model_id: "sonnet", name: "Sonnet 4.6" },
        ],
        modes: [],
        effort: null,
      },
      isLoading: false,
      isSuccess: true,
      isError: false,
    };

    const { rerender } = renderSection();
    probe.current = {
      data: undefined as never,
      isLoading: true,
      isSuccess: false,
      isError: false,
    };
    rerender(section);

    const trigger = screen.getByRole("combobox", { name: "Model for Coder" });
    expect(trigger).not.toBeDisabled();

    await userEvent.click(trigger);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "agent default",
      "Opus 4.7",
      "Sonnet 4.6",
    ]);
  });

  /** With no model chosen there is no name to keep, so the probe is what the field waits on. */
  it("says it is asking when no model is chosen yet", () => {
    stored.current = oneCoder(null);
    probe.current = { data: undefined as never, isLoading: true, isSuccess: false, isError: false };

    renderSection();

    expect(screen.getByRole("combobox", { name: "Model for Coder" })).toHaveTextContent(
      "asking the agent…",
    );
  });

  /**
   * An agent this machine does not have cannot be asked, and asking anyway would clear every field
   * of every profile naming it on sight. Not probing is what keeps a profile written on a machine
   * that has the agent intact on one that does not.
   */
  it("does not probe an agent this machine does not have", () => {
    const doc = oneCoder("opus", "auto", "high");
    doc.profiles![0]!.agent_id = "gemini";
    stored.current = doc;

    renderSection();

    expect(probeArgs).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Model for Coder" })).toHaveTextContent("opus");
  });

  /**
   * Effort is a property of the model, not of the agent — the same harness offers different
   * budgets per model. A probe that never names the profile's model reports the agent's *default*
   * model's list, which is the wrong list for every profile that picked another one.
   */
  it("asks the agent about the model the profile names", () => {
    stored.current = oneCoder("gpt-5-codex");

    renderSection();

    expect(probeArgs).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "claude-acp", modelId: "gpt-5-codex", enabled: true }),
    );
  });

  /**
   * A probe that failed and an agent that genuinely has one model both come back empty, and the
   * difference matters: one means "nothing to choose", the other means "we could not ask".
   */
  it("says when it could not ask the agent", () => {
    stored.current = oneCoder(null);
    probe.current = { data: undefined as never, isLoading: false, isSuccess: false, isError: true };

    renderSection();

    expect(screen.getByRole("combobox", { name: "Model for Coder" })).toHaveTextContent(
      "agent default (could not ask)",
    );
  });

  /**
   * The permission mode was the last free-text box on the card, and the one a typo costs most:
   * an unrecognised mode is dropped with a warning, so a reviewer meant to be held read-only
   * runs unheld. It comes off the same probe as the models.
   */
  it("names the chosen permission mode on the trigger", () => {
    stored.current = oneCoder(null, "auto");
    probe.current = {
      data: {
        models: [],
        modes: [
          { mode_id: "plan", name: "Plan" },
          { mode_id: "auto", name: "Auto" },
        ],
        effort: null,
      },
      isLoading: false,
      isSuccess: true,
      isError: false,
    };

    renderSection();

    expect(screen.getByRole("combobox", { name: "Permission mode for Coder" })).toHaveTextContent(
      "Auto",
    );
  });

  /**
   * Same rule as the model, and the mode has somewhere better to land than blank: the one the role
   * would have been given had it named none. A mode the agent does not have is not what holds a
   * read-only role read-only — it is dropped with a warning at spawn — so replacing it with a mode
   * the agent does have is what actually keeps the promise the stored value was making.
   */
  it("replaces a stored permission mode the agent does not offer", () => {
    stored.current = oneCoder(null, "dontAsk");
    probe.current = {
      data: {
        models: [],
        modes: [
          { mode_id: "plan", name: "Plan" },
          { mode_id: "auto", name: "Auto" },
        ],
        effort: null,
      },
      isLoading: false,
      isSuccess: true,
      isError: false,
    };

    renderSection();

    expect(screen.getByRole("combobox", { name: "Permission mode for Coder" })).toHaveTextContent(
      "Auto",
    );
    expect(lastSaved().profiles![0]!.permission_mode).toBe("auto");
  });

  /**
   * A profile that names no mode is filled in from what its agent offers, and the answer is
   * written to `profiles.json` rather than re-resolved invisibly on every spawn — a coder takes
   * the first writable mode, the other three the first read-only one.
   */
  it("fills in and stores the mode an unset role needs", () => {
    stored.current = {
      profiles: [
        {
          id: "r1",
          name: "Reviewer",
          role: "Reviewer",
          agent_id: "claude-acp",
          skills: [],
          mcp_servers: [],
          fallback_behaviour: "Warn",
        },
        {
          id: "c1",
          name: "Coder",
          role: "Coder",
          agent_id: "claude-acp",
          skills: [],
          mcp_servers: [],
          fallback_behaviour: "Warn",
        },
      ],
      defaults: { Reviewer: "r1", Coder: "c1" },
    };
    probe.current = {
      data: {
        models: [],
        modes: [
          { mode_id: "default", name: "Ask every time" },
          { mode_id: "plan", name: "Plan" },
          { mode_id: "auto", name: "Auto" },
        ],
        effort: null,
      },
      isLoading: false,
      isSuccess: true,
      isError: false,
    };

    renderSection();

    expect(
      screen.getByRole("combobox", { name: "Permission mode for Reviewer" }),
    ).toHaveTextContent("Plan");
    expect(screen.getByRole("combobox", { name: "Permission mode for Coder" })).toHaveTextContent(
      "Auto",
    );

    // Both cards resolve off one shared probe, so the document that lands on disk has to carry
    // both modes rather than whichever card wrote last.
    const saved = lastSaved().profiles!;
    expect(saved.find((p) => p.id === "r1")!.permission_mode).toBe("plan");
    expect(saved.find((p) => p.id === "c1")!.permission_mode).toBe("auto");
  });

  /**
   * Every entry has to be a mode the agent really has. A synthetic "chosen automatically" entry
   * reads as a selectable mode and is not one, and it hides which mode the profile actually runs
   * in behind a word — the point of storing the resolved mode is that the answer is on screen.
   */
  it("offers only modes the agent really has", async () => {
    stored.current = oneCoder(null, "auto");
    probe.current = {
      data: {
        models: [],
        modes: [
          { mode_id: "plan", name: "Plan" },
          { mode_id: "auto", name: "Auto" },
        ],
        effort: null,
      },
      isLoading: false,
      isSuccess: true,
      isError: false,
    };

    renderSection();
    await userEvent.click(screen.getByRole("combobox", { name: "Permission mode for Coder" }));

    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Plan", "Auto"]);
  });

  /**
   * Nothing to choose from is not the same as a choice not yet made. An enabled dropdown here
   * would open onto one dead option, and the mode is genuinely the agent's own.
   */
  it("disables the dropdown when the agent offers no modes", () => {
    stored.current = oneCoder(null);

    renderSection();

    expect(screen.getByRole("combobox", { name: "Permission mode for Coder" })).toBeDisabled();
    expect(
      screen.getByText("No permission mode available, the agent will use its own default."),
    ).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  /**
   * Effort is not part of ACP proper — it arrives as one entry in the generic config-option list,
   * found by category rather than read off a field, so that it is offered at all is worth pinning.
   */
  it("names the chosen effort on the trigger", () => {
    stored.current = oneCoder(null, null, "high");
    probe.current = {
      data: {
        models: [],
        modes: [],
        effort: {
          option_id: "reasoningEffort",
          values: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      },
      isLoading: false,
      isSuccess: true,
      isError: false,
    };

    renderSection();

    expect(screen.getByRole("combobox", { name: "Effort for Coder" })).toHaveTextContent("High");
  });

  /**
   * The field this rule matters most for: the spawn path sets the effort through
   * `set_acp_config_option` and swallows the rejection with a console warning, so a value the
   * model does not have was the one setting on the card that visibly did nothing.
   */
  it("clears a stored effort the model does not offer", () => {
    stored.current = oneCoder(null, null, "xhigh");
    probe.current = {
      data: {
        models: [],
        modes: [],
        effort: { option_id: "reasoningEffort", values: [{ value: "low", name: "Low" }] },
      },
      isLoading: false,
      isSuccess: true,
      isError: false,
    };

    renderSection();

    expect(screen.getByRole("combobox", { name: "Effort for Coder" })).toHaveTextContent(
      "agent default",
    );
    expect(lastSaved().profiles![0]!.effort).toBeNull();
  });

  /**
   * Most models expose no effort at all, which is why the field says so rather than offering an
   * empty list — and why it must not fill anything in, unlike the mode beside it.
   *
   * It names the model rather than the agent because that is what decides it: the probe runs
   * against the profile's own model, so "this agent has none" was both wrong and unactionable —
   * the fix is to pick a different model, not a different agent.
   */
  it("disables the dropdown and names the model when it exposes no effort", () => {
    stored.current = oneCoder("opus");
    probe.current = {
      data: { models: [{ model_id: "opus", name: "Opus" }], modes: [], effort: null },
      isLoading: false,
      isSuccess: true,
      isError: false,
    };

    renderSection();

    expect(screen.getByRole("combobox", { name: "Effort for Coder" })).toBeDisabled();
    expect(screen.getByText("Opus exposes no effort setting.")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  /** With no model chosen the probe ran against whichever one the agent opens on, so say that. */
  it("names the agent's default model when no model is chosen", () => {
    stored.current = oneCoder(null);

    renderSection();

    expect(
      screen.getByText("This agent's default model exposes no effort setting."),
    ).toBeInTheDocument();
  });

  /**
   * The label that started all this. Every field now shows a real, selectable option, so the
   * suffix has no state left to describe.
   */
  it("never labels anything as not offered", () => {
    stored.current = oneCoder("gpt-5-codex", "dontAsk", "xhigh");
    probe.current = {
      data: {
        models: [{ model_id: "sonnet", name: "Sonnet" }],
        modes: [{ mode_id: "auto", name: "Auto" }],
        effort: { option_id: "reasoningEffort", values: [{ value: "low", name: "Low" }] },
      },
      isLoading: false,
      isSuccess: true,
      isError: false,
    };

    renderSection();

    expect(screen.queryByText(/not offered/)).not.toBeInTheDocument();
  });
});
