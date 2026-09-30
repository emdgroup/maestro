import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectionKey, Task, TaskAttachment } from "@/types/bindings";

const api = vi.hoisted(() => ({
  resolveAgentProfile: vi.fn(),
  listTaskAttachments: vi.fn(),
  prepareTaskAttachments: vi.fn(),
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

function link(path: string) {
  return { type: "resource_link", name: path.split("/").pop(), uri: `file://${path}` };
}

/** The attachment blocks of the prompt the session was started with. */
function sentLinks() {
  const blocks = api.sendAcpPromptStructured.mock.calls[0][1] as { type: string }[];
  return blocks.filter((block) => block.type === "resource_link");
}

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
  api.prepareTaskAttachments.mockImplementation((_projectId: number, paths: string[]) =>
    Promise.resolve(paths.map((path) => (path === GONE.file_path ? null : link(path)))),
  );
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
  mutations.spawnAcpSession.mockResolvedValue({ session_id: "42" });
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

    expect(sentLinks()).toEqual([link(PRESENT.file_path)]);
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
    expect(sentLinks()).toEqual([link(PRESENT.file_path)]);
    expect(mutations.deleteAttachment).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalled();
    expect(mutations.markSessionReady).toHaveBeenCalled();
  });

  it("asks nothing when every file is readable", async () => {
    api.prepareTaskAttachments.mockImplementation((_projectId: number, paths: string[]) =>
      Promise.resolve(paths.map(link)),
    );
    const { result } = render();

    await act(async () => {
      await result.current.execute(TASK);
    });

    expect(result.current.missingAttachments).toBeNull();
    expect(sentLinks()).toEqual([link(GONE.file_path), link(PRESENT.file_path)]);
    expect(mutations.deleteAttachment).not.toHaveBeenCalled();
  });

  /** Not being able to ask is not an answer: no row is offered for deletion on the strength of it. */
  it("starts without them, deleting nothing, when the project's machine cannot be asked", async () => {
    api.prepareTaskAttachments.mockRejectedValue(new Error("connection lost"));
    const { result } = render();

    await act(async () => {
      await result.current.execute(TASK);
    });

    expect(result.current.missingAttachments).toBeNull();
    expect(sentLinks()).toEqual([]);
    expect(mutations.deleteAttachment).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalled();
  });
});
