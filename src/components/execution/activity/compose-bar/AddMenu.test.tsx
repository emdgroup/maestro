import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/ui/tooltip";
import { AddMenu } from "./AddMenu";
import type { Prompt } from "@/types/bindings";

const api = vi.hoisted(() => ({ listPrompts: vi.fn() }));
vi.mock("@/lib/tauri-utils", () => ({ api }));

function prompt(id: number, title: string, fields: Partial<Prompt> = {}): Prompt {
  return {
    id,
    title,
    body: `${title} body`,
    tags: [],
    shared: false,
    favorite: false,
    created_at: "2026-11-19T10:00:00Z",
    updated_at: "2026-11-19T10:00:00Z",
    ...fields,
  };
}

function setup(projectId: number | null = 1) {
  api.listPrompts.mockImplementation(async (_id: number, shared: boolean) =>
    shared
      ? [prompt(1, "Commit message", { shared: true, tags: ["git"] })]
      : [prompt(1, "Review the diff", { favorite: true }), prompt(2, "Write tests first")],
  );
  const onAttach = vi.fn();
  const onInsertPrompt = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <AddMenu
          disabled={false}
          projectId={projectId}
          onAttach={onAttach}
          onInsertPrompt={onInsertPrompt}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { onAttach, onInsertPrompt, user: userEvent.setup() };
}

describe("AddMenu", () => {
  it("attaches files from the menu", async () => {
    const { onAttach, user } = setup();
    await user.click(screen.getByLabelText("Add to message"));
    await user.click(screen.getByText("Attach files"));
    expect(onAttach).toHaveBeenCalledOnce();
  });

  it("inserts the picked prompt's body, searching by tag across both collections", async () => {
    const { onInsertPrompt, user } = setup();
    await user.click(screen.getByLabelText("Add to message"));
    await user.click(screen.getByText("Insert prompt"));
    expect(await screen.findByText("Write tests first")).toBeTruthy();
    expect(screen.getByText("This project")).toBeTruthy();
    expect(screen.getByText("Shared")).toBeTruthy();

    await user.type(screen.getByPlaceholderText("Search prompts by title or tag..."), "git{Enter}");
    expect(onInsertPrompt).toHaveBeenCalledWith("Commit message body");
  });

  it("moves the highlight with the arrow keys", async () => {
    const { onInsertPrompt, user } = setup();
    await user.click(screen.getByLabelText("Add to message"));
    await user.click(screen.getByText("Insert prompt"));
    await screen.findByText("Write tests first");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onInsertPrompt).toHaveBeenCalledWith("Write tests first body");
  });

  it("steps back to the menu on Escape instead of closing", async () => {
    const { user } = setup();
    await user.click(screen.getByLabelText("Add to message"));
    await user.click(screen.getByText("Insert prompt"));
    await screen.findByText("Write tests first");
    await user.keyboard("{Escape}");
    expect(screen.getByText("Attach files")).toBeTruthy();
  });

  it("lists only shared prompts for a session without a project", async () => {
    const { user } = setup(null);
    await user.click(screen.getByLabelText("Add to message"));
    await user.click(screen.getByText("Insert prompt"));
    // Once in the list and once in the preview, as the only prompt it is highlighted.
    expect(await screen.findAllByText("Commit message")).toHaveLength(2);
    expect(screen.queryByText("This project")).toBeNull();
    expect(api.listPrompts).toHaveBeenCalledTimes(1);
  });
});
