import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TaskAttachment } from "@/types/bindings";

const listTaskAttachments = vi.fn();
const addTaskAttachment = vi.fn();
const deleteTaskAttachment = vi.fn();
const toastInfo = vi.fn();

vi.mock("@/lib/tauri-utils", () => ({
  api: {
    listTaskAttachments: (...a: unknown[]) => listTaskAttachments(...a),
    addTaskAttachment: (...a: unknown[]) => addTaskAttachment(...a),
    deleteTaskAttachment: (...a: unknown[]) => deleteTaskAttachment(...a),
  },
}));

vi.mock("sonner", () => ({
  toast: { info: (...a: unknown[]) => toastInfo(...a), error: vi.fn(), success: vi.fn() },
}));

const { AttachmentSection } = await import("./AttachmentSection");
const { useAddTaskAttachmentMutation, taskQueryKeys } = await import("@/services/task.service");

const NOTES: TaskAttachment = {
  id: 7,
  task_id: 1,
  filename: "notes.txt",
  file_path: "/tmp/notes.txt",
  file_size: 1024,
  created_at: "2026-01-01T00:00:00Z",
};

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AttachmentSection", () => {
  it("removes the row the user removed, and only that row", async () => {
    listTaskAttachments.mockResolvedValue([NOTES]);
    deleteTaskAttachment.mockResolvedValue(undefined);

    render(
      <QueryClientProvider client={newClient()}>
        <AttachmentSection
          taskId={1}
          projectId={1}
          isEditable
          onPickFiles={() => {}}
          isDragging={false}
        />
      </QueryClientProvider>,
    );

    const row = (await screen.findByText("notes.txt")).closest("li");
    expect(row).toBeTruthy();
    await userEvent.click(within(row!).getByRole("button"));

    await waitFor(() => expect(deleteTaskAttachment).toHaveBeenCalledWith(NOTES.id));
  });
});

describe("useAddTaskAttachmentMutation", () => {
  it("says so rather than recording a file the task already has", async () => {
    const client = newClient();
    client.setQueryData(taskQueryKeys.attachments(1), [NOTES]);

    function Harness() {
      const add = useAddTaskAttachmentMutation();
      return (
        <button
          onClick={() =>
            add.mutate({ taskId: 1, filename: NOTES.filename, filePath: NOTES.file_path })
          }
        >
          attach
        </button>
      );
    }

    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "attach" }));

    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("notes.txt is already attached"));
    expect(addTaskAttachment).not.toHaveBeenCalled();
  });

  it("records a file the task does not have yet", async () => {
    const client = newClient();
    client.setQueryData(taskQueryKeys.attachments(1), [NOTES]);
    addTaskAttachment.mockResolvedValue({ ...NOTES, id: 8, file_path: "/tmp/other/notes.txt" });

    function Harness() {
      const add = useAddTaskAttachmentMutation();
      return (
        <button
          onClick={() =>
            add.mutate({ taskId: 1, filename: "notes.txt", filePath: "/tmp/other/notes.txt" })
          }
        >
          attach
        </button>
      );
    }

    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "attach" }));

    await waitFor(() =>
      expect(addTaskAttachment).toHaveBeenCalledWith(1, "notes.txt", "/tmp/other/notes.txt"),
    );
    expect(toastInfo).not.toHaveBeenCalled();
  });
});
