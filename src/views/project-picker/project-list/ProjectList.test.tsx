import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectList } from "./ProjectList";
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

const recentProjects = vi.hoisted(() => [] as Array<{ id: number; path: string }>);
const requestTakeover = vi.hoisted(() => vi.fn());
const openProject = vi.hoisted(() => vi.fn());
const setSelectedProject = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const primeProjectServer = vi.hoisted(() => vi.fn());
const eventHandlers = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (event: { payload: unknown }) => void) => {
    eventHandlers.set(name, handler);
    return Promise.resolve(() => {});
  },
}));

vi.mock("@/lib/tauri-utils", () => ({
  api: {
    openProject,
    primeProjectServer,
  },
}));

vi.mock("@/services/project.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/project.service")>();
  return {
    ...actual,
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
    useDeleteProject: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useRecentProjects: () => ({
      data: recentProjects,
      isLoading: false,
    }),
    useCheckIsGitRepo: () => ({ mutateAsync: () => Promise.resolve(true) }),
    useRequestProjectTakeover: () => ({ mutateAsync: requestTakeover }),
    useProjectLocks: () => ({
      data: [],
      isLoading: false,
    }),
  };
});

vi.mock("@/store/projectStore", () => ({
  useSelectedProjectActions: () => ({ setSelectedProject }),
  applyProjectStartupTab: () => Promise.resolve(),
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

vi.mock("@/hooks/useProjectPickerNavigation", () => ({
  useProjectPickerNavigation: () => ({
    navigateToConnections: vi.fn(),
  }),
}));

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
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
}

describe("ProjectList", () => {
  beforeEach(() => {
    callOrder.length = 0;
    recentProjects.length = 0;
    vi.clearAllMocks();
    primeProjectServer.mockResolvedValue(undefined);
  });

  describe("a project whose board could not be moved to its server", () => {
    beforeEach(() => {
      recentProjects.push({ id: 7, path: "/work/maestro" });
      openProject.mockResolvedValue({ id: 7, path: "/work/maestro" });
    });

    it("stays closed and offers a retry that reruns the open", async () => {
      primeProjectServer.mockRejectedValueOnce(
        "IMPORT_FAILED:The board could not be moved: disk full",
      );
      renderList();
      fireEvent.click(screen.getByText("/work/maestro"));
      await waitFor(() => expect(toastError).toHaveBeenCalled());
      const [message, options] = toastError.mock.calls[0];
      expect(message).toBe("The board could not be moved: disk full");
      expect(setSelectedProject).not.toHaveBeenCalled();

      expect(options.action.label).toBe("Retry");
      options.action.onClick();
      await waitFor(() => expect(setSelectedProject).toHaveBeenCalled());
      expect(primeProjectServer).toHaveBeenCalledTimes(2);
    });

    it("still opens when priming fails for another reason", async () => {
      primeProjectServer.mockRejectedValueOnce("agent failed to start");
      renderList();
      fireEvent.click(screen.getByText("/work/maestro"));
      await waitFor(() => expect(setSelectedProject).toHaveBeenCalled());
      expect(toastError).not.toHaveBeenCalled();
    });

    it("says it is moving the board only for the project it is opening", async () => {
      let finishPrime = () => {};
      primeProjectServer.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishPrime = resolve;
        }),
      );
      renderList();
      fireEvent.click(screen.getByText("/work/maestro"));
      await screen.findByText("Warming up…");

      act(() => eventHandlers.get("project-importing")?.({ payload: 8 }));
      expect(screen.getByText("Warming up…")).toBeTruthy();

      act(() => eventHandlers.get("project-importing")?.({ payload: 7 }));
      expect(screen.getByText("Moving this project's board to its server…")).toBeTruthy();
      act(() => finishPrime());
    });
  });

  it("imports useGitInitProject from project.service and renders without error", () => {
    const { container } = renderList();
    expect(container).toBeTruthy();
  });

  describe("a project another window holds", () => {
    beforeEach(() => {
      recentProjects.push({ id: 7, path: "/work/maestro" });
      openProject.mockRejectedValueOnce(new Error("PROJECT_LOCKED:desktop"));
    });

    async function askForTakeover() {
      renderList();
      fireEvent.click(screen.getByText("/work/maestro"));
      await screen.findByText("Open in Maestro on desktop. Request takeover?");
      fireEvent.click(screen.getByText("Request takeover"));
    }

    it("opens it once the holder lets go", async () => {
      requestTakeover.mockResolvedValue(true);
      openProject.mockResolvedValue({ id: 7, path: "/work/maestro" });
      await askForTakeover();
      await waitFor(() => expect(setSelectedProject).toHaveBeenCalled());
      expect(requestTakeover).toHaveBeenCalledWith(7);
      expect(openProject).toHaveBeenCalledTimes(2);
    });

    it("says so when the holder keeps it", async () => {
      requestTakeover.mockResolvedValue(false);
      await askForTakeover();
      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("Maestro on desktop kept the project"),
      );
      expect(openProject).toHaveBeenCalledTimes(1);
      expect(setSelectedProject).not.toHaveBeenCalled();
    });
  });
});
