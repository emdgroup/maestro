import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectionKey, Task, TaskAttachment } from "@/types/bindings";

const api = vi.hoisted(() => ({
  resolveAgentProfile: vi.fn(),
  checkWorktreeDirty: vi.fn(),
  stashWorktree: vi.fn(),
  listWorktreesWithStatus: vi.fn(),
  listTaskAttachments: vi.fn(),
  prepareTaskAttachments: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

const startTask = vi.hoisted(() => vi.fn());
const setAuthRequired = vi.hoisted(() => vi.fn());
const deleteAttachment = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri-utils", () => ({ api }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/services/task.service", () => ({
  startTask,
  useDeleteTaskAttachmentMutation: () => ({ mutateAsync: deleteAttachment }),
}));
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
  api.listTaskAttachments.mockResolvedValue([]);
  deleteAttachment.mockResolvedValue(undefined);
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

function attachment(id: number, filename: string): TaskAttachment {
  return {
    id,
    task_id: TASK.id,
    filename,
    file_path: `/tmp/repo/.maestro/attachments/tasks/3/${filename}`,
    file_size: 10,
    created_at: "now",
  };
}

const GONE = attachment(1, "gone.md");
const BIG = attachment(2, "big.png");
const FINE = attachment(3, "fine.md");

describe("useExecuteTask with attachments it cannot send", () => {
  beforeEach(() => {
    api.listTaskAttachments.mockResolvedValue([GONE, BIG, FINE]);
    api.prepareTaskAttachments.mockResolvedValue([
      { content_block: null, rejection: null },
      { content_block: null, rejection: "Image too large" },
      { content_block: { type: "text", text: "ok" }, rejection: null },
    ]);
  });

  const startAndWaitForDialog = async (result: ReturnType<typeof render>["result"]) => {
    let started!: Promise<void>;
    act(() => {
      started = result.current.execute(TASK);
    });
    await waitFor(() => expect(result.current.missingAttachments).not.toBeNull());
    // Wrapped, or the async function would wait on the start it hands back.
    return { started };
  };

  it("offers the missing and the oversized, and starts nothing when cancelled", async () => {
    const { result } = render();
    const { started } = await startAndWaitForDialog(result);
    expect(api.prepareTaskAttachments).toHaveBeenCalledWith(7, [GONE, BIG, FINE]);
    expect(result.current.missingAttachments).toEqual([
      expect.objectContaining({ id: GONE.id, missing: true }),
      expect.objectContaining({ id: BIG.id, problem: "Image too large", missing: false }),
    ]);
    await act(async () => {
      result.current.onAttachmentsCancel();
      await started;
    });
    expect(startTask).not.toHaveBeenCalled();
    expect(deleteAttachment).not.toHaveBeenCalled();
  });

  it("removes only the missing copies on Continue, then starts", async () => {
    const { result } = render();
    const { started } = await startAndWaitForDialog(result);
    await act(async () => {
      result.current.onAttachmentsContinue();
      await started;
    });
    expect(deleteAttachment).toHaveBeenCalledTimes(1);
    expect(deleteAttachment).toHaveBeenCalledWith({ projectId: 7, attachmentId: 1, taskId: 3 });
    expect(startTask).toHaveBeenCalled();
    expect(result.current.missingAttachments).toBeNull();
  });

  it("asks nothing on an unattended start", async () => {
    const { result } = render();
    await act(() => result.current.execute(TASK, { unattended: true }));
    expect(api.listTaskAttachments).not.toHaveBeenCalled();
    expect(startTask).toHaveBeenCalled();
  });

  it("starts without asking when the check cannot run", async () => {
    api.prepareTaskAttachments.mockRejectedValue(new Error("connection lost"));
    const { result } = render();
    await act(() => result.current.execute(TASK));
    expect(result.current.missingAttachments).toBeNull();
    expect(deleteAttachment).not.toHaveBeenCalled();
    expect(startTask).toHaveBeenCalled();
  });
});
