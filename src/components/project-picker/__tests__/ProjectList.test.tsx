import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectList } from "../ProjectList";
import { ConnectionContext } from "@/contexts/ConnectionContext";

// Track call order
const callOrder: string[] = [];
const mockGitInitProject = vi.fn().mockImplementation(() => {
  callOrder.push("gitInit");
  return Promise.resolve();
});
const mockCreateProject = vi.fn().mockImplementation(() => {
  callOrder.push("createProject");
  return Promise.resolve({ id: 1, name: "test", path: "/test" });
});

vi.mock("@/services/project.service", () => ({
  useGitInitProject: () => ({
    mutateAsync: mockGitInitProject,
    isPending: false,
  }),
  useCreateProject: () => ({
    mutateAsync: mockCreateProject,
    isPending: false,
  }),
  useCloneProject: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useCreateNewProject: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useRemoveProject: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useRecentProjects: () => ({
    data: [],
    isLoading: false,
  }),
  useProjectLocks: () => ({
    data: [],
    isLoading: false,
  }),
}));

vi.mock("@/store/projectStore", () => ({
  useSelectedProjectActions: () => ({
    setSelectedProject: vi.fn(),
  }),
}));

// Mock child components to isolate
vi.mock("../ProjectsListLayout", () => ({
  ProjectsListLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="projects-list-layout">{children}</div>
  ),
}));

vi.mock("../FilePicker", () => ({
  FilePicker: () => <div data-testid="file-picker">FilePicker</div>,
}));

vi.mock("../CloneProjectDialog", () => ({
  CloneProjectDialog: () => null,
}));

vi.mock("../CreateProjectDialog", () => ({
  CreateProjectDialog: () => null,
}));

vi.mock("../ConnectionHeader", () => ({
  ConnectionHeader: () => <div data-testid="connection-header">ConnectionHeader</div>,
}));

vi.mock("../ProjectListItem", () => ({
  ProjectListItem: () => <div data-testid="project-list-item">ProjectListItem</div>,
}));

vi.mock("@/utils/hooks", () => ({
  useProjectPickerNavigation: () => ({
    navigateToConnections: vi.fn(),
  }),
}));

describe("ProjectList", () => {
  beforeEach(() => {
    callOrder.length = 0;
    vi.clearAllMocks();
  });

  it("imports useGitInitProject from project.service and renders without error", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <ConnectionContext.Provider
          value={{
            view: "projects",
            setView: vi.fn(),
            activeConnection: { type: "local", id: 0, displayName: "Local" },
            setActiveConnection: vi.fn(),
            preflightStatus: "passed",
            preflightResult: null,
            preflightError: null,
            startPreflight: vi.fn(),
            ignoreWarnings: vi.fn(),
            resetPreflight: vi.fn(),
          }}
        >
          <ProjectList />
        </ConnectionContext.Provider>
      </QueryClientProvider>,
    );
    expect(container).toBeTruthy();
  });
});
