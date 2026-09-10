import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskProfilesDialog } from "./TaskProfilesDialog";
import type { AgentProfile, ProfilesDocument, Task } from "@/types/bindings";

/** What `.maestro/profiles.json` holds for the project, swapped per test. */
const stored = vi.hoisted(() => ({ current: { profiles: [], defaults: {} } as ProfilesDocument }));
const setOverrides = vi.hoisted(() => vi.fn());

vi.mock("@/services/project.service", () => ({
  useAgentProfilesQuery: () => ({ data: stored.current }),
}));

vi.mock("@/services/task.service", () => ({
  useSetTaskProfileOverridesMutation: () => ({ mutate: setOverrides }),
}));

const profile = (id: string, role: AgentProfile["role"], name: string): AgentProfile => ({
  id,
  name,
  role,
  agent_id: "claude-acp",
  skills: [],
  mcp_servers: [],
  fallback_behaviour: "Warn",
});

/** Only the fields this dialog reads. */
function task(overrides: string | null = null): Task {
  return { id: 7, title: "Ship it", profile_overrides: overrides } as Task;
}

function renderDialog(taskOverrides: string | null = null) {
  render(
    <TaskProfilesDialog
      task={task(taskOverrides)}
      projectId={1}
      open={true}
      onOpenChange={() => {}}
    />,
  );
}

/** The map handed to the most recent write. */
function lastSaved(): Record<string, string | null> {
  const calls = setOverrides.mock.calls;
  return calls[calls.length - 1]![0].overrides as Record<string, string | null>;
}

describe("TaskProfilesDialog", () => {
  beforeEach(() => {
    setOverrides.mockReset();
    stored.current = {
      profiles: [
        profile("f1", "Refiner", "Sharpener"),
        profile("p1", "Planner", "Planner"),
        profile("c1", "Coder", "Coder"),
        profile("r1", "Reviewer", "Reviewer"),
      ],
      defaults: {},
    };
  });

  /**
   * "Skipped" was only ever expressible by the project not defining a profile at all. This is the
   * per-task half of it, and only the two stages the pipeline starts by itself get the entry.
   *
   * The other two are excluded for opposite reasons, and both are asserted with a profile in place
   * so this fails if the entry ever appears rather than passing on an empty list: a task that runs
   * no coder does nothing, and nothing hands work to the refiner in the first place — the user
   * presses Refine — so declining it would only disable a button they need not press.
   */
  it("offers a skip entry only for the stages the pipeline starts on its own", async () => {
    renderDialog();

    for (const stage of ["Planning", "Review"]) {
      await userEvent.click(screen.getByRole("combobox", { name: stage }));
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toContain("Skip this stage");
      await userEvent.keyboard("{Escape}");
    }

    for (const stage of ["Refinement", "Implementation"]) {
      await userEvent.click(screen.getByRole("combobox", { name: stage }));
      const options = screen.getAllByRole("option").map((o) => o.textContent);
      expect(options).not.toContain("Skip this stage");
      // The list is non-empty, so "not offered" is a real absence rather than nothing rendering.
      expect(options.length).toBeGreaterThan(1);
      await userEvent.keyboard("{Escape}");
    }
  });

  /**
   * A role the project has no profile for is already skipped and has nothing to choose between,
   * so it keeps the disabled select it had rather than gaining a skip entry that changes nothing.
   */
  it("leaves a role with no profile disabled", async () => {
    stored.current = { profiles: [profile("c1", "Coder", "Coder")], defaults: {} };

    renderDialog();

    const review = screen.getByRole("combobox", { name: "Review" });
    expect(review).toBeDisabled();
    expect(review).toHaveTextContent("No profile (stage skipped)");
  });

  /**
   * `null`, not an omission. The saved map drops "use the project default" because an absent key
   * already means that — and a skip that went through the same filter would be indistinguishable
   * from never having been set.
   */
  it("saves a skipped stage as null and leaves the untouched ones out", async () => {
    renderDialog();

    await userEvent.click(screen.getByRole("combobox", { name: "Review" }));
    await userEvent.click(screen.getByRole("option", { name: "Skip this stage" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(setOverrides).toHaveBeenCalledTimes(1);
    expect(setOverrides.mock.calls[0]![0].taskId).toBe(7);
    expect(lastSaved()).toEqual({ Reviewer: null });
  });

  /** What is stored has to come back as a choice, or reopening would silently un-skip the stage. */
  it("shows a stored skip as the current choice", async () => {
    renderDialog('{"Planner":null,"Reviewer":"r1"}');

    expect(screen.getByRole("combobox", { name: "Planning" })).toHaveTextContent("Skip this stage");
    expect(screen.getByRole("combobox", { name: "Review" })).toHaveTextContent("Reviewer");

    // And survives a save that touched neither.
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(lastSaved()).toEqual({ Planner: null, Reviewer: "r1" });
  });

  /** Choosing a profile after a skip has to clear the skip rather than sit alongside it. */
  it("replaces a skip with the profile the user picks instead", async () => {
    renderDialog('{"Planner":null}');

    await userEvent.click(screen.getByRole("combobox", { name: "Planning" }));
    await userEvent.click(screen.getByRole("option", { name: "Planner" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(lastSaved()).toEqual({ Planner: "p1" });
  });
});
