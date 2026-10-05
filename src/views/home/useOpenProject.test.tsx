import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useOpenProject } from "./useOpenProject";

const requestTakeover = vi.hoisted(() => vi.fn());
const openProject = vi.hoisted(() => vi.fn());
const setSelectedProject = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const primeProjectServer = vi.hoisted(() => vi.fn());
const releaseActiveProjectLock = vi.hoisted(() => vi.fn());
const eventHandlers = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (event: { payload: unknown }) => void) => {
    eventHandlers.set(name, handler);
    return Promise.resolve(() => {});
  },
}));

vi.mock("@/lib/tauri-utils", () => ({
  api: { openProject, primeProjectServer, releaseActiveProjectLock },
}));

vi.mock("@/services/project.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/project.service")>();
  return {
    ...actual,
    useGitInitProject: () => ({ mutateAsync: vi.fn() }),
    useCreateProject: () => ({ mutateAsync: vi.fn() }),
    useCheckIsGitRepo: () => ({ mutateAsync: () => Promise.resolve(true) }),
    useRequestProjectTakeover: () => ({ mutateAsync: requestTakeover }),
  };
});

vi.mock("@/store/projectStore", () => ({
  useSelectedProjectActions: () => ({ setSelectedProject }),
  applyProjectStartupTab: () => Promise.resolve(),
}));

function Harness() {
  const { openProject: open, importing, dialogs } = useOpenProject();
  return (
    <>
      <button onClick={() => void open(7)}>Open maestro</button>
      {importing && <span>Moving this project's board to its server…</span>}
      {dialogs}
    </>
  );
}

function renderHarness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe("useOpenProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    primeProjectServer.mockResolvedValue(undefined);
    releaseActiveProjectLock.mockResolvedValue(undefined);
  });

  describe("a project whose board could not be moved to its server", () => {
    beforeEach(() => {
      openProject.mockResolvedValue({ id: 7, path: "/work/maestro" });
    });

    it("stays closed and offers a retry that reruns the open", async () => {
      primeProjectServer.mockRejectedValueOnce(
        "IMPORT_FAILED:The board could not be moved: disk full",
      );
      renderHarness();
      fireEvent.click(screen.getByText("Open maestro"));
      await waitFor(() => expect(toastError).toHaveBeenCalled());
      const [message, options] = toastError.mock.calls[0];
      expect(message).toBe("The board could not be moved: disk full");
      expect(setSelectedProject).not.toHaveBeenCalled();
      expect(releaseActiveProjectLock).toHaveBeenCalledTimes(1);

      expect(options.action.label).toBe("Retry");
      options.action.onClick();
      await waitFor(() => expect(setSelectedProject).toHaveBeenCalled());
      expect(primeProjectServer).toHaveBeenCalledTimes(2);
    });

    it("still opens when priming fails for another reason", async () => {
      primeProjectServer.mockRejectedValueOnce("agent failed to start");
      renderHarness();
      fireEvent.click(screen.getByText("Open maestro"));
      await waitFor(() => expect(setSelectedProject).toHaveBeenCalled());
      expect(toastError).not.toHaveBeenCalled();
      expect(releaseActiveProjectLock).not.toHaveBeenCalled();
    });

    it("says it is moving the board only for the project it is opening", async () => {
      let finishPrime = () => {};
      primeProjectServer.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishPrime = resolve;
        }),
      );
      renderHarness();
      fireEvent.click(screen.getByText("Open maestro"));
      await waitFor(() => expect(primeProjectServer).toHaveBeenCalled());

      act(() => eventHandlers.get("project-importing")?.({ payload: 8 }));
      expect(screen.queryByText("Moving this project's board to its server…")).toBeNull();

      act(() => eventHandlers.get("project-importing")?.({ payload: 7 }));
      expect(screen.getByText("Moving this project's board to its server…")).toBeTruthy();
      act(() => finishPrime());
    });
  });

  describe("a project another window holds", () => {
    beforeEach(() => {
      openProject.mockRejectedValueOnce(new Error("PROJECT_LOCKED:desktop"));
    });

    async function askForTakeover() {
      renderHarness();
      fireEvent.click(screen.getByText("Open maestro"));
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
