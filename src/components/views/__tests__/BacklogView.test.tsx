import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BacklogView } from "../BacklogView";

// Mock services
vi.mock("@/services/task.service", () => ({
  useTasksQuery: vi.fn().mockReturnValue({ data: [], isLoading: false }),
  useDeleteTaskMutation: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  useUpdateTask: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  useProjectBranchesQuery: vi.fn().mockReturnValue({ data: [[], "main"] }),
}));

const mockUseProjectTicketingConfig = vi.fn();
vi.mock("@/services/integration.service", () => ({
  useProjectIssueTrackingConfig: () => mockUseProjectTicketingConfig(),
}));

vi.mock("@/contexts/KanbanContext", () => ({
  useKanban: vi.fn().mockReturnValue({ projectId: 1 }),
}));

vi.mock("@/components/kanban/BacklogTaskSheet", () => ({
  BacklogTaskSheet: () => <div data-testid="backlog-task-sheet" />,
}));

vi.mock("@/components/kanban/ImportTicketsModal", () => ({
  ImportTicketsModal: () => <div data-testid="import-tickets-modal" />,
}));

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("BacklogView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseProjectTicketingConfig.mockReturnValue({ data: null });
  });

  it("IMPT-01: Import tickets button is hidden when issueTrackingConfig is null", () => {
    mockUseProjectTicketingConfig.mockReturnValue({ data: null });
    render(<BacklogView search="" priorityFilter="All" />, { wrapper: createWrapper() });
    expect(screen.queryByText("Import tickets")).toBeNull();
  });

  it("IMPT-01: Import tickets button is visible when issueTrackingConfig is non-null", () => {
    mockUseProjectTicketingConfig.mockReturnValue({
      data: { provider: "github" },
    });
    render(<BacklogView search="" priorityFilter="All" />, { wrapper: createWrapper() });
    expect(screen.getByText("Import tickets")).toBeInTheDocument();
  });
});
