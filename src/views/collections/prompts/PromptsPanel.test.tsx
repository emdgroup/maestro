import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PromptsPanel } from "./PromptsPanel";
import type { Prompt, PromptInput } from "@/types/bindings";

const api = vi.hoisted(() => ({
  listPrompts: vi.fn(),
  savePrompt: vi.fn(),
  setPromptFavorite: vi.fn(),
  copyPrompt: vi.fn(),
  deletePrompt: vi.fn(),
}));
vi.mock("@/lib/tauri-utils", () => ({ api }));

// Drags cannot be driven in happy-dom, so the provider's handlers and the droppables are captured
// and called directly.
const dnd = vi.hoisted(() => ({
  droppables: [] as Array<{ id: string; accept: unknown }>,
  onDragEnd: null as null | ((event: unknown) => void),
}));
vi.mock("@dnd-kit/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/react")>();
  return {
    ...actual,
    // A real draggable measures layout on pointer events, which happy-dom does not have.
    useDraggable: () => ({ ref: () => {}, handleRef: () => {}, isDragging: false }),
    useDroppable: (input: Parameters<typeof actual.useDroppable>[0]) => {
      dnd.droppables.push(input as { id: string; accept: unknown });
      return actual.useDroppable(input);
    },
    DragDropProvider: (props: Parameters<typeof actual.DragDropProvider>[0]) => {
      dnd.onDragEnd = props.onDragEnd as (event: unknown) => void;
      return <actual.DragDropProvider {...props} />;
    },
  };
});

function prompt(id: number, fields: Partial<Prompt>): Prompt {
  return {
    id,
    title: `Prompt ${id}`,
    body: `Body ${id}`,
    tags: [],
    shared: false,
    favorite: false,
    created_at: "2026-09-24T10:00:00Z",
    updated_at: "2026-09-24T10:00:00Z",
    ...fields,
  };
}

function Harness() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Prompt | null>(null);
  const [newShared, setNewShared] = useState(false);
  return (
    <>
      <button type="button" onClick={() => (setEditing(null), setOpen(true))}>
        New prompt
      </button>
      <PromptsPanel
        projectId={7}
        editorOpen={open}
        onEditorOpenChange={setOpen}
        editing={editing}
        newShared={newShared}
        onEdit={(p) => (setEditing(p), setOpen(true))}
        onNew={(shared) => (setEditing(null), setNewShared(shared), setOpen(true))}
      />
    </>
  );
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dnd.droppables.length = 0;
  dnd.onDragEnd = null;
  api.listPrompts.mockImplementation(async (_projectId: number, shared: boolean) =>
    shared
      ? [prompt(1, { title: "Review changes", tags: ["review"], shared: true, favorite: true })]
      : [prompt(2, { title: "Local only", tags: ["tests"] })],
  );
  api.savePrompt.mockImplementation(async (_projectId: number, input: PromptInput) =>
    prompt(3, { ...input, id: 3 }),
  );
});

describe("PromptsPanel", () => {
  it("shows each collection in its own column and filters to favorites", async () => {
    const user = userEvent.setup();
    renderPanel();
    const project = await screen.findByRole("region", { name: "This project" });
    const shared = screen.getByRole("region", { name: "Shared" });
    expect(await within(project).findByText("Local only")).toBeInTheDocument();
    expect(within(shared).getByText("Review changes")).toBeInTheDocument();
    expect(within(shared).getByText(/Stored in this app/)).toBeInTheDocument();
    expect(api.listPrompts).toHaveBeenCalledWith(7, false);
    expect(api.listPrompts).toHaveBeenCalledWith(7, true);

    await user.click(screen.getByRole("button", { name: "Favorites" }));
    expect(screen.queryByText("Local only")).not.toBeInTheDocument();
    expect(screen.getByText("Review changes")).toBeInTheDocument();
    expect(within(project).getByText("No prompt matches.")).toBeInTheDocument();
  });

  it("keeps one column when the other fails, and retries it", async () => {
    const user = userEvent.setup();
    api.listPrompts.mockImplementation(async (_projectId: number, shared: boolean) => {
      if (!shared) throw "daemon unreachable";
      return [prompt(1, { title: "Review changes", shared: true })];
    });
    renderPanel();
    const project = await screen.findByRole("region", { name: "This project" });
    expect(await within(project).findByText("daemon unreachable")).toBeInTheDocument();
    expect(screen.getByText("Review changes")).toBeInTheDocument();

    api.listPrompts.mockResolvedValueOnce([prompt(2, { title: "Local only" })]);
    await user.click(within(project).getByRole("button", { name: "Retry" }));
    expect(await within(project).findByText("Local only")).toBeInTheDocument();
  });

  it("draws an empty collection as a drop target for the other's cards", async () => {
    api.listPrompts.mockImplementation(async (_projectId: number, shared: boolean) =>
      shared ? [] : [prompt(2, { title: "Local only" })],
    );
    api.copyPrompt.mockResolvedValue(prompt(1, { shared: true }));
    renderPanel();
    const shared = await screen.findByRole("region", { name: "Shared" });
    expect(await within(shared).findByText("No shared prompts yet.")).toBeInTheDocument();
    expect(within(shared).getByTestId("prompts-shared")).toBeInTheDocument();
    expect(dnd.droppables).toContainEqual(
      expect.objectContaining({ id: "shared", accept: "project" }),
    );
    expect(dnd.droppables).toContainEqual(
      expect.objectContaining({ id: "project", accept: "shared" }),
    );

    const source = { data: prompt(2, { title: "Local only" }) };
    dnd.onDragEnd!({ canceled: true, operation: { source, target: { id: "shared" } } });
    dnd.onDragEnd!({ canceled: false, operation: { source, target: null } });
    expect(api.copyPrompt).not.toHaveBeenCalled();
    dnd.onDragEnd!({ canceled: false, operation: { source, target: { id: "shared" } } });
    await waitFor(() => expect(api.copyPrompt).toHaveBeenCalledWith(7, 2, false));
  });

  it("copies the prompt text when the card is clicked", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    renderPanel();
    await screen.findByText("Local only");
    await user.click(screen.getByRole("button", { name: "Copy “Local only”" }));
    expect(writeText).toHaveBeenCalledWith("Body 2");
  });

  it("stars without an edit", async () => {
    const user = userEvent.setup();
    api.setPromptFavorite.mockResolvedValue(prompt(2, { favorite: true }));
    renderPanel();
    await screen.findByText("Local only");
    await user.click(screen.getByRole("button", { name: "Add to favorites" }));
    expect(api.setPromptFavorite).toHaveBeenCalledWith(7, 2, false, true);
    expect(api.savePrompt).not.toHaveBeenCalled();
  });

  it("copies into the other collection from the first menu item", async () => {
    const user = userEvent.setup();
    api.copyPrompt.mockResolvedValue(prompt(3, { shared: true }));
    renderPanel();
    await screen.findByText("Review changes");
    await user.click(screen.getByRole("button", { name: "More actions for Review changes" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items[0]).toHaveTextContent("Copy to this project");
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "More actions for Local only" }));
    const first = (await screen.findAllByRole("menuitem"))[0]!;
    expect(first).toHaveTextContent("Copy to shared");
    await user.click(first);
    expect(api.copyPrompt).toHaveBeenCalledWith(7, 2, false);
    expect(api.savePrompt).not.toHaveBeenCalled();
  });

  it("creates a prompt in the column it was started from", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Local only");
    await user.click(screen.getByRole("button", { name: "New prompt in shared" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Shared" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.type(within(dialog).getByLabelText("Title"), "Explain module");
    await user.click(within(dialog).getByText("Write the prompt…"));
    await user.keyboard("Explain how it works");
    await user.type(within(dialog).getByLabelText("Tags"), "Onboarding{Enter}docs,");
    await user.click(within(dialog).getByRole("button", { name: "Create prompt" }));

    await waitFor(() =>
      expect(api.savePrompt).toHaveBeenCalledWith(7, {
        id: null,
        title: "Explain module",
        body: "Explain how it works",
        tags: ["onboarding", "docs"],
        shared: true,
        favorite: false,
      }),
    );
  });

  it("deletes only after confirming", async () => {
    const user = userEvent.setup();
    api.deletePrompt.mockResolvedValue(null);
    renderPanel();
    await screen.findByText("Local only");
    await user.click(screen.getByRole("button", { name: "More actions for Local only" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(api.deletePrompt).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(api.deletePrompt).toHaveBeenCalledWith(7, 2, false);
  });
});
