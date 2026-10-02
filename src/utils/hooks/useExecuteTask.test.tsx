import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectionKey, Task } from "@/types/bindings";

const api = vi.hoisted(() => ({
  resolveAgentProfile: vi.fn(),
  checkWorktreeDirty: vi.fn(),
  stashWorktree: vi.fn(),
  listWorktreesWithStatus: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

const startTask = vi.hoisted(() => vi.fn());
const setAuthRequired = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri-utils", () => ({ api }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/services/task.service", () => ({ startTask }));
vi.mock("@/services/worktree.service", () => ({
  worktreeQueryKeys: { list: (id: number) => ["worktrees", id] },
}));
vi.mock("@/services/execution.service", () => ({
  useActiveSessionsQuery: () => ({ data: [] }),
  useAgentDiscoveryQuery: () => ({ data: { agents: [{ id: "claude" }] } }),
}));
vi.mock("@/store/boardStore", () => ({
  useBoardStore: { getState: () => ({ setAuthRequired }) },
}));

import { useExecuteTask } from "./useExecuteTask";

const TASK = {
  id: 3,
  title: "Fix the thing",
  status: "Queue",
  phase: null,
  agent_id: "claude",
  workspace_mode: "RepositoryDirectory",
} as Task;

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(
    () => useExecuteTask(7, "/tmp/repo", { type: "local" } as unknown as ConnectionKey),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.checkWorktreeDirty.mockResolvedValue({ modified_count: 0, untracked_count: 0 });
  api.resolveAgentProfile.mockResolvedValue(null);
  startTask.mockResolvedValue({ session_id: "42", skipped_attachments: [] });
});

describe("useExecuteTask", () => {
  it("asks the daemon to start the stage", async () => {
    const { result } = render();
    await act(() =>
      result.current.execute(TASK, {
        role: "Planner",
        feedback: " shorter ",
        respectCapacity: true,
      }),
    );
    expect(startTask).toHaveBeenCalledWith(7, 3, "Planner", "shorter", false, true, null);
    expect(toast.success).toHaveBeenCalled();
  });

  it("names the attachments an attended start went without", async () => {
    startTask.mockResolvedValue({ session_id: "42", skipped_attachments: ["a.png: missing"] });
    const { result } = render();
    await act(() => result.current.execute(TASK));
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("1 attachment"), {
      description: "a.png: missing",
    });
  });

  it("says a deferred start is queued", async () => {
    startTask.mockResolvedValue({ session_id: null, skipped_attachments: [] });
    const { result } = render();
    await act(() => result.current.execute(TASK));
    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining("will start when an agent"));
  });

  it("opens the sign-in prompt for the agent the daemon names", async () => {
    startTask.mockRejectedValue(new Error("auth_required:gemini"));
    const { result } = render();
    await act(() => result.current.execute(TASK));
    expect(setAuthRequired).toHaveBeenCalledWith("3", "gemini", { type: "local" }, null);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("offers the agent picker and starts again with the choice", async () => {
    startTask
      .mockRejectedValueOnce(new Error('No agent to run the Implementation stage of "x".'))
      .mockResolvedValueOnce({ session_id: "42", skipped_attachments: [] });
    const { result } = render();

    let started: Promise<void>;
    act(() => {
      started = result.current.execute(TASK, { canPickAgent: true });
    });
    await waitFor(() => expect(result.current.agentPickerTask).not.toBeNull());
    await act(async () => {
      result.current.onAgentPicked("codex");
      await started;
    });

    expect(startTask).toHaveBeenCalledTimes(2);
    expect(startTask).toHaveBeenLastCalledWith(7, 3, "Coder", null, false, false, "codex");
    expect(toast.success).toHaveBeenCalled();
  });

  it("asks about uncommitted work on a click and not on a handoff", async () => {
    api.checkWorktreeDirty.mockResolvedValue({ modified_count: 2, untracked_count: 0 });
    const { result } = render();

    await act(() => result.current.execute(TASK, { unattended: true }));
    expect(api.checkWorktreeDirty).not.toHaveBeenCalled();

    let started: Promise<void>;
    act(() => {
      started = result.current.execute(TASK);
    });
    await waitFor(() => expect(result.current.dirtyDialogOpen).toBe(true));
    await act(async () => {
      result.current.onDirtyCancel();
      await started;
    });
    expect(startTask).toHaveBeenCalledTimes(1);
  });

  it("does not ask about uncommitted work when the planner runs first", async () => {
    api.checkWorktreeDirty.mockResolvedValue({ modified_count: 2, untracked_count: 0 });
    api.resolveAgentProfile.mockResolvedValue({ agent_id: "claude" });
    const { result } = render();
    await act(() => result.current.execute(TASK));
    expect(api.checkWorktreeDirty).not.toHaveBeenCalled();
    expect(startTask).toHaveBeenCalledTimes(1);
  });
});
