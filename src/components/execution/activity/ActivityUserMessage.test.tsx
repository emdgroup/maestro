import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/ui/tooltip";
import { ActivityUserMessage } from "./ActivityUserMessage";
import type { PromptInput } from "@/types/bindings";

const api = vi.hoisted(() => ({ listPrompts: vi.fn(), savePrompt: vi.fn() }));
vi.mock("@/lib/tauri-utils", () => ({ api }));

describe("ActivityUserMessage", () => {
  it("saves the message as a project prompt through a prefilled editor", async () => {
    api.listPrompts.mockResolvedValue([]);
    api.savePrompt.mockImplementation(async (_projectId: number, input: PromptInput) => input);
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ActivityUserMessage
            message={{ id: "m1", content: "## Review the diff\nCheck every hunk." } as never}
            projectId={7}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    await user.click(screen.getByLabelText("Save as project prompt"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText<HTMLInputElement>("Title").value).toBe("Review the diff");

    await user.click(within(dialog).getByText("Create prompt"));
    await waitFor(() =>
      expect(api.savePrompt).toHaveBeenCalledWith(7, {
        id: null,
        title: "Review the diff",
        body: "## Review the diff\nCheck every hunk.",
        tags: [],
        shared: false,
        favorite: false,
      }),
    );
  });

  it("hides the action without a project", () => {
    render(
      <TooltipProvider>
        <ActivityUserMessage message={{ id: "m1", content: "hello" } as never} />
      </TooltipProvider>,
    );
    expect(screen.queryByLabelText("Save as project prompt")).toBeNull();
  });
});
