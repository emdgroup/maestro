import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Task } from "@/types/bindings";

const updateSettings = vi.hoisted(() => vi.fn());

vi.mock("@/contexts/KanbanContext", () => ({
  useKanban: () => ({ projectId: 7, connection: { type: "local" } }),
}));
vi.mock("@/services/execution.service", () => ({
  useAgentDiscoveryQuery: () => ({ data: { agents: [{ id: "codex", name: "Codex" }] } }),
}));
vi.mock("@/services/project.service", () => ({
  useProjectSettings: () => ({
    data: { startup_tab: "kanban", default_workspace_mode: "NewWorktree" },
  }),
  useUpdateProjectSettings: () => ({ mutateAsync: updateSettings }),
}));

import { AgentPickerModal } from "./AgentPickerModal";

describe("AgentPickerModal", () => {
  it("makes the picked agent the project default, then starts with it", async () => {
    updateSettings.mockResolvedValue(undefined);
    const proceed = vi.fn();
    render(
      <AgentPickerModal open task={{ title: "x" } as Task} proceed={proceed} onClose={vi.fn()} />,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByText("Codex"));
    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => expect(proceed).toHaveBeenCalledWith("codex"));
    expect(updateSettings).toHaveBeenCalledWith({
      projectId: 7,
      config: expect.objectContaining({ default_agent: "codex", startup_tab: "kanban" }),
    });
  });
});
