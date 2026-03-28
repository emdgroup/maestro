import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBoardStore } from "./boardStore";
import type { Task, TaskStatus } from "@/types/bindings";

// Mock the api module — boardStore's async methods (executeTask etc.) call Tauri.
// Only the pure state operations are tested here.
vi.mock("@/lib", () => ({
  api: {
    spawnAgentExecution: vi.fn(),
    pauseAgentExecution: vi.fn(),
    resumeAgentExecution: vi.fn(),
    cancelExecution: vi.fn(),
    detachTerminal: vi.fn(),
  },
}));

function makeTask(id: number, status: TaskStatus): Task {
  return {
    id,
    name: `Task ${id}`,
    description: "",
    status,
    priority: "Medium",
    skills: [],
    project_id: 1,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };
}

function resetStore() {
  useBoardStore.setState({
    tasks: [],
    activeTerminalTaskId: null,
    isTerminalOpen: false,
    pausingTaskIds: new Set(),
  });
}

describe("boardStore – loadTasks", () => {
  beforeEach(resetStore);

  it("replaces tasks array", () => {
    const tasks = [makeTask(1, "Ready"), makeTask(2, "InProgress")];
    useBoardStore.getState().loadTasks(tasks);
    expect(useBoardStore.getState().tasks).toHaveLength(2);
  });

  it("clears existing tasks when loading empty array", () => {
    useBoardStore.getState().loadTasks([makeTask(1, "Ready")]);
    useBoardStore.getState().loadTasks([]);
    expect(useBoardStore.getState().tasks).toHaveLength(0);
  });
});

describe("boardStore – addTask", () => {
  beforeEach(resetStore);

  it("appends a task to the list", () => {
    useBoardStore.getState().addTask(makeTask(1, "Backlog"));
    useBoardStore.getState().addTask(makeTask(2, "Ready"));
    expect(useBoardStore.getState().tasks).toHaveLength(2);
  });
});

describe("boardStore – updateTaskStatus", () => {
  beforeEach(resetStore);

  it("updates status of existing task", () => {
    useBoardStore.getState().loadTasks([makeTask(1, "Ready")]);
    useBoardStore.getState().updateTaskStatus(1, "InProgress");
    expect(useBoardStore.getState().tasks[0]?.status).toBe("InProgress");
  });

  it("does nothing for unknown task id", () => {
    useBoardStore.getState().loadTasks([makeTask(1, "Ready")]);
    useBoardStore.getState().updateTaskStatus(999, "Done");
    expect(useBoardStore.getState().tasks[0]?.status).toBe("Ready");
  });

  it("does not affect other tasks", () => {
    useBoardStore.getState().loadTasks([makeTask(1, "Ready"), makeTask(2, "Backlog")]);
    useBoardStore.getState().updateTaskStatus(1, "InProgress");
    expect(useBoardStore.getState().tasks[1]?.status).toBe("Backlog");
  });
});

describe("boardStore – getTasks / getTasksByStatus", () => {
  beforeEach(resetStore);

  it("getTasks returns all tasks", () => {
    const tasks = [makeTask(1, "Ready"), makeTask(2, "Done")];
    useBoardStore.getState().loadTasks(tasks);
    expect(useBoardStore.getState().getTasks()).toHaveLength(2);
  });

  it("getTasksByStatus filters correctly", () => {
    useBoardStore.getState().loadTasks([
      makeTask(1, "Ready"),
      makeTask(2, "Ready"),
      makeTask(3, "Done"),
    ]);
    const ready = useBoardStore.getState().getTasksByStatus("Ready");
    expect(ready).toHaveLength(2);
    expect(ready.every((t) => t.status === "Ready")).toBe(true);
  });

  it("getTasksByStatus returns empty array when no matches", () => {
    useBoardStore.getState().loadTasks([makeTask(1, "Ready")]);
    expect(useBoardStore.getState().getTasksByStatus("Done")).toHaveLength(0);
  });
});

describe("boardStore – openTerminal / terminal state", () => {
  beforeEach(resetStore);

  it("openTerminal sets activeTerminalTaskId and isTerminalOpen", () => {
    useBoardStore.getState().openTerminal(5);
    const s = useBoardStore.getState();
    expect(s.activeTerminalTaskId).toBe(5);
    expect(s.isTerminalOpen).toBe(true);
  });
});
