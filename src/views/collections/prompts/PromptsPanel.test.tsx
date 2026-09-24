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
  setPromptShared: vi.fn(),
  deletePrompt: vi.fn(),
}));
vi.mock("@/lib/tauri-utils", () => ({ api }));

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
        onEdit={(p) => (setEditing(p), setOpen(true))}
        onNew={() => setOpen(true)}
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
  api.listPrompts.mockResolvedValue([
    prompt(1, { title: "Review changes", tags: ["review"], shared: true, favorite: true }),
    prompt(2, { title: "Local only", tags: ["tests"] }),
  ]);
  api.savePrompt.mockImplementation(async (_projectId: number, input: PromptInput) =>
    prompt(3, { ...input, id: 3 }),
  );
});

describe("PromptsPanel", () => {
  it("lists favorites first and filters to shared ones", async () => {
    const user = userEvent.setup();
    renderPanel();
    const favorites = (await screen.findByRole("heading", { name: /Favorites/ })).closest(
      "section",
    )!;
    expect(within(favorites).getByText("Review changes")).toBeInTheDocument();
    expect(screen.getByText("Local only")).toBeInTheDocument();
    expect(api.listPrompts).toHaveBeenCalledWith(7);

    await user.click(screen.getByRole("button", { name: "Shared" }));
    expect(screen.queryByText("Local only")).not.toBeInTheDocument();
    expect(screen.getByText("Review changes")).toBeInTheDocument();
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
    expect(api.setPromptFavorite).toHaveBeenCalledWith(7, 2, true);
    expect(api.savePrompt).not.toHaveBeenCalled();
  });

  it("shares from the card without an edit", async () => {
    const user = userEvent.setup();
    api.setPromptShared.mockResolvedValue(prompt(2, { shared: true }));
    renderPanel();
    await screen.findByText("Local only");
    expect(
      screen.getByRole("button", { name: "Stop sharing with all projects" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Share with all projects" }));
    expect(api.setPromptShared).toHaveBeenCalledWith(7, 2, true);
    expect(api.savePrompt).not.toHaveBeenCalled();
  });

  it("creates a shared prompt with its tags", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Local only");
    await user.click(screen.getByRole("button", { name: "New prompt" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Title"), "Explain module");
    await user.click(within(dialog).getByText("Write the prompt…"));
    await user.keyboard("Explain how it works");
    await user.type(within(dialog).getByLabelText("Tags"), "Onboarding{Enter}docs,");
    await user.click(within(dialog).getByRole("button", { name: "Shared" }));
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
    expect(api.deletePrompt).toHaveBeenCalledWith(2);
  });
});
