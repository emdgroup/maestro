import { describe, it, vi } from "vitest";

// Mock all hooks the component will use
vi.mock("@/services/task.service", () => ({
  useCreateTaskMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useProjectBranchesQuery: vi.fn(() => ({
    data: [["main", "feature/foo", "develop"], "main"],
    isFetching: false,
  })),
  useFetchRemoteIssuesQuery: vi.fn(() => ({
    data: [
      {
        external_id: "ISS-1",
        title: "Fix bug",
        body: "Bug desc",
        url: "",
        labels: [],
        updated_at: "",
        priority: "High",
      },
    ],
    isFetching: false,
  })),
  taskQueryKeys: { base: ["tasks"] },
}));

vi.mock("@/services/integration.service", () => ({
  useProjectIssueTrackingConfig: vi.fn(() => ({ data: null })),
}));

vi.mock("@/services/execution.service", () => ({
  useAgentDiscoveryQuery: vi.fn(() => ({
    data: { agents: [{ id: "agent-1", name: "Claude" }] },
  })),
}));

vi.mock("@/services/project.service", () => ({
  useProjectSettings: vi.fn(() => ({ data: { default_agent: "agent-1" } })),
}));

vi.mock("@/store/projectStore", () => ({
  useSelectedProject: vi.fn(() => ({ id: 1, connection_id: 1, wsl_connection_id: null })),
}));

describe("CreateTaskModal", () => {
  // CREATE-01: From Branch form renders all required fields
  it.todo("renders title, description, branch combobox, priority, agent, and toggle fields when open");

  // CREATE-02: From Issue tab hidden when no provider configured
  it.todo("hides From Issue tab when useProjectIssueTrackingConfig returns null");

  // CREATE-02: From Issue tab visible when provider configured
  it.todo("shows From Issue tab when useProjectIssueTrackingConfig returns a config");

  // CREATE-02: Issue selection pre-fills title and description
  it.todo("pre-fills title and description when an issue is selected");

  // CREATE-03: Branch combobox renders branch options
  it.todo("renders branch options in combobox from useProjectBranchesQuery data");

  // CREATE-03: Branch combobox auto-selects current branch
  it.todo("auto-selects the current branch as default value");

  // CREATE-04: Create another toggle keeps modal open after submit
  it.todo("keeps modal open and resets only title/description when create-another is toggled on");

  // CREATE-04: Create another toggle off closes modal after submit
  it.todo("closes modal after successful submit when create-another is off");
});
