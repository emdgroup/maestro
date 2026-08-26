import { describe, it, expect } from "vitest";
import { clampPriority, priorityAfterDrop } from "./queue-priority";
import type { Task, TaskPriority } from "@/types/bindings";

function makeTask(id: number, priority: TaskPriority): Task {
  return {
    id,
    project_id: 1,
    title: `task ${id}`,
    status: "Queue",
    priority,
    base_branch: "main",
    skills: [],
    labels: [],
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    auto_approve: false,
    isolated_worktree: true,
    phase: null,
    phase_status: null,
    ball: "None",
    completion: null,
  } as unknown as Task;
}

describe("clampPriority", () => {
  /// The case the rule was written for: order and priority are one fact, so jumping the queue
  /// has to mean claiming the priority that position implies.
  it("raises a card dropped above a higher-priority one", () => {
    expect(clampPriority("Low", "Urgent", "High")).toBe("High");
  });

  it("lowers a card dropped below a lower-priority one", () => {
    expect(clampPriority("Urgent", "Low", "None")).toBe("Low");
  });

  /// A clamp, not an adoption. Dragging within a run of equal-priority cards must not promote.
  it("leaves a card that already fits between its neighbours alone", () => {
    expect(clampPriority("Medium", "High", "Low")).toBe("Medium");
    expect(clampPriority("High", "High", "High")).toBe("High");
  });

  /// Only a lower bound at the top: the card must outrank what is below it, and may outrank it
  /// by more than one step.
  it("applies only the lower bound at the top", () => {
    expect(clampPriority("Low", undefined, "High")).toBe("High");
    expect(clampPriority("Urgent", undefined, "Medium")).toBe("Urgent");
  });

  /// Only an upper bound at the bottom, symmetrically.
  it("applies only the upper bound at the bottom", () => {
    expect(clampPriority("Urgent", "Medium", undefined)).toBe("Medium");
    expect(clampPriority("None", "Medium", undefined)).toBe("None");
  });

  it("leaves the only card in a queue untouched", () => {
    expect(clampPriority("Low", undefined, undefined)).toBe("Low");
  });
});

describe("priorityAfterDrop", () => {
  const tasks = [
    makeTask(1, "Urgent"),
    makeTask(2, "High"),
    makeTask(3, "Low"),
    makeTask(4, "None"),
  ];

  it("reports the new priority for a card that jumped the queue", () => {
    // 3 (Low) dropped between 1 (Urgent) and 2 (High).
    expect(priorityAfterDrop([1, 3, 2, 4], 3, tasks)).toBe("High");
  });

  /// Null rather than the unchanged value, so the caller writes nothing at all.
  it("reports nothing when the drop changes no priority", () => {
    expect(priorityAfterDrop([1, 2, 3, 4], 3, tasks)).toBeNull();
  });

  it("reports nothing for a task that is not in the queue", () => {
    expect(priorityAfterDrop([1, 2, 4], 3, tasks)).toBeNull();
    expect(priorityAfterDrop([1, 2, 3, 4], 99, tasks)).toBeNull();
  });

  /// The drop position is read against the post-drop order, so a card landing first is bounded
  /// only by what is now beneath it.
  it("handles a drop at the head of the queue", () => {
    expect(priorityAfterDrop([3, 1, 2, 4], 3, tasks)).toBe("Urgent");
  });

  it("handles a drop at the tail of the queue", () => {
    expect(priorityAfterDrop([2, 3, 4, 1], 1, tasks)).toBe("None");
  });
});
