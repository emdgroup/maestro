import { describe, it, vi } from "vitest";

vi.mock("@/services/task.service", () => ({
  useTasksQuery: vi.fn(() => ({
    data: [
      {
        id: 1,
        title: "Completed task",
        status: "Done",
        priority: "Medium",
        labels: [],
        archived_at: "2026-05-01T00:00:00Z",
        updated_at: "2026-05-01T00:00:00Z",
      },
      {
        id: 2,
        title: "Cancelled task",
        status: "Cancelled",
        priority: "Low",
        labels: [],
        archived_at: null,
        updated_at: "2026-05-02T00:00:00Z",
      },
    ],
    isLoading: false,
  })),
}));

vi.mock("@/store/navigationStore", () => ({
  useNavigationActions: vi.fn(() => ({
    setActiveTaskId: vi.fn(),
  })),
}));

describe("ArchiveModal", () => {
  it.todo("renders task list when isOpen=true");
  it.todo("filters tasks by search input value");
  it.todo("shows only Done tasks when Done tab selected");
  it.todo("shows only Cancelled tasks when Cancelled tab selected");
  it.todo("calls setActiveTaskId and onClose when a task row is clicked");
});
