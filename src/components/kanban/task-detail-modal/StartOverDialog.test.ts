import { describe, expect, it } from "vitest";
import type { Task } from "@/types/bindings";
import { runControls } from "./StartOverDialog";
import { statusDetail } from "./TaskStatusChip";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 30,
    project_id: 1,
    title: "Capture usage",
    status: "InProgress",
    priority: "None",
    base_branch: "main",
    skills: [],
    labels: [],
    created_at: "2026-10-17T09:00:00Z",
    updated_at: "2026-10-17T09:00:00Z",
    auto_approve: false,
    workspace_mode: "NewWorktree",
    phase: "Implementing",
    phase_status: "Running",
    ball: "Agent",
    run_mode: "Pipeline",
    ...overrides,
  } as Task;
}

describe("runControls", () => {
  it("offers Stop while an agent works and Start over once nothing does", () => {
    expect(runControls(task())).toEqual({ live: true, startOver: false });
    expect(runControls(task({ phase_status: "Failed", ball: "User" }))).toEqual({
      live: false,
      startOver: true,
    });
    expect(runControls(task({ status: "Done", phase: null, phase_status: null }))).toEqual({
      live: false,
      startOver: true,
    });
  });

  it("offers neither before the task has run, nor while a hand-off waits for a slot", () => {
    const parked = { phase: null, phase_status: null, ball: "None" } as const;
    expect(runControls(task({ status: "Queue", ...parked })).startOver).toBe(false);
    expect(runControls(task({ phase_status: "Waiting", ball: "Agent" }))).toEqual({
      live: false,
      startOver: false,
    });
    expect(runControls(task({ phase: "Spawning", phase_status: null })).startOver).toBe(false);
  });
});

describe("statusDetail", () => {
  it("says what the task is doing in its column", () => {
    expect(statusDetail(task())).toBe("Implementing");
    expect(statusDetail(task({ phase_status: "Failed", ball: "User" }))).toBe(
      "Implementing, stopped",
    );
    expect(
      statusDetail(
        task({ status: "Review", phase: "Approval", phase_status: "Waiting", ball: "User" }),
      ),
    ).toBe("Needs your approval");
    expect(statusDetail(task({ status: "Planning", phase: null, phase_status: null }))).toBeNull();
  });
});
