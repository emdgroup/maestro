import { describe, it, vi } from "vitest";

vi.mock("@/services/task.service", () => ({
  useTasksQuery: vi.fn().mockReturnValue({ data: [], isLoading: false }),
  useDeleteTaskMutation: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  useUpdateTask: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  useProjectBranchesQuery: vi.fn().mockReturnValue({ data: [[], "main"] }),
}));

vi.mock("@/services/integration.service", () => ({
  useProjectTicketingConfig: vi.fn().mockReturnValue({ data: null }),
}));

vi.mock("@/contexts/KanbanContext", () => ({
  useKanban: vi.fn().mockReturnValue({ projectId: 1 }),
}));

describe("BacklogView", () => {
  it.todo("IMPT-01: Import tickets button is hidden when ticketingConfig is null");
  it.todo("IMPT-01: Import tickets button is visible when ticketingConfig is non-null");
});
