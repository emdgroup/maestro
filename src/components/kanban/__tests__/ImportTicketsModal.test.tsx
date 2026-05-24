import { describe, it, vi } from "vitest";

// These mocks will be populated after ImportTicketsModal is created in Task 2.
// For now the describe blocks act as Wave 0 stubs.

vi.mock("@/services/task.service", () => ({
  useFetchRemoteIssuesQuery: vi.fn().mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useImportTasksMutation: vi.fn().mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  }),
  useUpdateTaskFromRemoteMutation: vi.fn().mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  }),
  useDismissTaskChangeMutation: vi.fn().mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  }),
  useTasksQuery: vi.fn().mockReturnValue({ data: [], isLoading: false }),
  useProjectBranchesQuery: vi.fn().mockReturnValue({ data: [[], "main"] }),
}));

vi.mock("@/services/integration.service", () => ({
  useProjectTicketingConfig: vi.fn().mockReturnValue({ data: null }),
  PROVIDER_NAMES: { github: "GitHub" },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

describe("ImportTicketsModal", () => {
  it.todo("IMPT-02: renders 3 tabs: Available, Imported, Changed");
  it.todo("IMPT-02: tab switching changes active tab");
  it.todo("IMPT-04: refetchInterval is 5*60*1000 when modal is open");
  it.todo("IMPT-04: refetchInterval is false when modal is closed");
  it.todo("IMPT-05: Refresh button calls refetch()");
  it.todo("IMPT-06: label filter hides rows that don't match selected label");
  it.todo("CHNG-01: issue classified as Changed when remote updated_at differs from task external_updated_at");
  it.todo("CHNG-02: Update task button calls updateTaskFromRemote mutation");
  it.todo("CHNG-02: Dismiss change button calls dismissTaskChange mutation");
});
