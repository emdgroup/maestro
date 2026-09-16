import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectionKey, Task, TaskAttachment } from "@/types/bindings";

const api = vi.hoisted(() => ({
  resolveAgentProfile: vi.fn(),
  listTaskAttachments: vi.fn(),
  validateAttachment: vi.fn(),
  prepareExternalAttachments: vi.fn(),
  listTaskComments: vi.fn(),
  getTaskReview: vi.fn(),
  sendAcpPromptStructured: vi.fn(),
  clearTaskReview: vi.fn(),
  checkWorktreeDirty: vi.fn(),
  cancelAcpSession: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

const mutations = vi.hoisted(() => ({
  markExecutionStarted: vi.fn(),
  markSessionReady: vi.fn(),
  releaseClaim: vi.fn(),
  deleteAttachment: vi.fn(),
  claimWorktree: vi.fn(),
  spawnAcpSession: vi.fn(),
}));

vi.mock("@/lib/tauri-utils", () => ({ api }));
vi.mock("sonner", () => ({ toast }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    // The hook waits on this before it will send a prompt, so the handshake has to complete or
    // every test would sit out the 30s timeout.
    if (event.startsWith("acp://spawn-ok/")) queueMicrotask(() => handler({ payload: null }));
    return Promise.resolve(() => {});
  },
}));

vi.mock("@/hooks/useResolveWorktree", () => ({
  useResolveWorktree: () => ({ resolveWorktree: vi.fn() }),
}));

vi.mock("@/services/worktree.service", () => ({
  useClaimWorktreeForTaskMutation: () => ({ mutateAsync: mutations.claimWorktree }),
  worktreeQueryKeys: { list: (id: number) => ["worktrees", id] },
}));

vi.mock("@/services/execution.service", () => ({
  useSpawnAcpSessionMutation: () => ({ mutateAsync: mutations.spawnAcpSession }),
  useActiveSessionsQuery: () => ({ data: [] }),
  useAgentDiscoveryQuery: () => ({ data: { agents: [{ id: "claude" }] } }),
}));

vi.mock("@/services/task.service", () => ({
  useMarkTaskExecutionStartedMutation: () => ({ mutateAsync: mutations.markExecutionStarted }),
  useMarkTaskSessionReadyMutation: () => ({ mutateAsync: mutations.markSessionReady }),
  useReleaseTaskExecutionClaimMutation: () => ({ mutateAsync: mutations.releaseClaim }),
  useDeleteTaskAttachmentMutation: () => ({ mutateAsync: mutations.deleteAttachment }),
}));

vi.mock("@/services/project.service", () => ({
  useProjectSettings: () => ({ data: { default_agent: "claude" } }),
}));

import { useExecuteTask } from "./useExecuteTask";

const TASK = {
  id: 3,
  title: "Fix the thing",
  description: "do it",
  status: "Queue",
  phase: null,
  agent_id: "claude",
  workspace_mode: "RepositoryDirectory",
} as Task;

function attachment(id: number, filename: string): TaskAttachment {
  return {
    id,
    task_id: TASK.id,
    filename,
    file_path: `/tmp/${filename}`,
    file_size: 10,
    created_at: "now",
  };
}

const GONE = attachment(1, "gone.md");
const PRESENT = attachment(2, "here.md");

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
  api.resolveAgentProfile.mockResolvedValue(null);
  api.listTaskAttachments.mockResolvedValue([GONE, PRESENT]);
  api.validateAttachment.mockImplementation((path: string) =>
    path === GONE.file_path
      ? Promise.reject(new Error(`Cannot read '${path}': No such file or directory`))
      : Promise.resolve({ size_bytes: 10, rejection: null }),
  );
  api.prepareExternalAttachments.mockResolvedValue([]);
  api.listTaskComments.mockResolvedValue([]);
  api.getTaskReview.mockResolvedValue(null);
  api.sendAcpPromptStructured.mockResolvedValue(undefined);
  api.clearTaskReview.mockResolvedValue(undefined);
  api.checkWorktreeDirty.mockResolvedValue({ modified_count: 0, untracked_count: 0 });
  api.cancelAcpSession.mockResolvedValue(undefined);
  mutations.markExecutionStarted.mockResolvedValue(true);
  mutations.markSessionReady.mockResolvedValue(true);
  mutations.releaseClaim.mockResolvedValue(undefined);
  mutations.deleteAttachment.mockResolvedValue(undefined);
  mutations.spawnAcpSession.mockResolvedValue({ log_id: 42 });
});

describe("useExecuteTask with an attachment whose file is gone", () => {
  /**
   * The check runs before the claim, so parking is a plain return: nothing was built, so there is
   * no session to cancel and no claim to hand back.
   */
  it("parks without claiming or spawning anything", async () => {
    const { result } = render();

    let started: Promise<void>;
    act(() => {
      started = result.current.execute(TASK);
    });

    await waitFor(() => expect(result.current.missingAttachments).not.toBeNull());
    expect(result.current.missingAttachments).toEqual([
      expect.objectContaining({ id: GONE.id, filename: "gone.md", file_path: GONE.file_path }),
    ]);

    await act(async () => {
      result.current.onAttachmentsPark();
      await started;
    });

    expect(mutations.markExecutionStarted).not.toHaveBeenCalled();
    expect(mutations.spawnAcpSession).not.toHaveBeenCalled();
    expect(api.cancelAcpSession).not.toHaveBeenCalled();
    expect(mutations.releaseClaim).not.toHaveBeenCalled();
  });

  it("continues with the attachments that survive and drops the dead rows", async () => {
    const { result } = render();

    let started: Promise<void>;
    act(() => {
      started = result.current.execute(TASK);
    });

    await waitFor(() => expect(result.current.missingAttachments).not.toBeNull());

    await act(async () => {
      result.current.onAttachmentsContinue();
      await started;
    });

    expect(api.prepareExternalAttachments).toHaveBeenCalledWith(
      42,
      [{ path: PRESENT.file_path, is_image: false }],
      true,
    );
    expect(mutations.deleteAttachment).toHaveBeenCalledTimes(1);
    expect(mutations.deleteAttachment).toHaveBeenCalledWith({
      attachmentId: GONE.id,
      taskId: TASK.id,
    });
    expect(mutations.markSessionReady).toHaveBeenCalledWith({ taskId: TASK.id, role: "Coder" });
  });

  /**
   * Nobody renders the dialog on an unattended start, so awaiting it would hang the task at
   * `Spawning` with the claim never released. The rows are left alone — skipping them for one run
   * is not the same consent as deleting them.
   */
  it("skips them with a warning when nobody can be asked", async () => {
    const { result } = render();

    await act(async () => {
      await result.current.execute(TASK, { unattended: true });
    });

    expect(result.current.missingAttachments).toBeNull();
    expect(api.prepareExternalAttachments).toHaveBeenCalledWith(
      42,
      [{ path: PRESENT.file_path, is_image: false }],
      true,
    );
    expect(mutations.deleteAttachment).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalled();
    expect(mutations.markSessionReady).toHaveBeenCalled();
  });

  /**
   * A `rejection` means the file is on disk but too big to send. It breaks the start the same way,
   * so it is offered here — but the row still points at a real file, so Continue must not delete it.
   */
  it("keeps the row of a file that exists but is too big", async () => {
    api.validateAttachment.mockImplementation((path: string) =>
      Promise.resolve({
        size_bytes: 10,
        rejection: path === GONE.file_path ? "Image is over 10 MB" : null,
      }),
    );
    const { result } = render();

    let started: Promise<void>;
    act(() => {
      started = result.current.execute(TASK);
    });

    await waitFor(() => expect(result.current.missingAttachments).not.toBeNull());

    await act(async () => {
      result.current.onAttachmentsContinue();
      await started;
    });

    expect(api.prepareExternalAttachments).toHaveBeenCalledWith(
      42,
      [{ path: PRESENT.file_path, is_image: false }],
      true,
    );
    expect(mutations.deleteAttachment).not.toHaveBeenCalled();
  });

  it("asks nothing when every file is readable", async () => {
    api.validateAttachment.mockResolvedValue({ size_bytes: 10, rejection: null });
    const { result } = render();

    await act(async () => {
      await result.current.execute(TASK);
    });

    expect(result.current.missingAttachments).toBeNull();
    expect(api.prepareExternalAttachments).toHaveBeenCalledWith(
      42,
      [
        { path: GONE.file_path, is_image: false },
        { path: PRESENT.file_path, is_image: false },
      ],
      true,
    );
    expect(mutations.deleteAttachment).not.toHaveBeenCalled();
  });
});
