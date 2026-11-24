import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/settings.service", () => ({ useSettings: () => ({ data: undefined }) }));

import { SubagentCard } from "./SubagentCard";
import { SubagentControlsContext, type SubagentControls } from "./subagent-controls";
import type { SubagentFacts } from "./agentMeta";
import type { ToolCallItem } from "./types";

function subagent(
  facts: Partial<SubagentFacts> = {},
  over: Partial<ToolCallItem> = {},
): ToolCallItem {
  return {
    toolCallId: "subagent:child",
    title: "Worker B",
    kind: "subagent",
    status: "in_progress",
    content: [],
    locations: [],
    rawInput: { prompt: "Run it." },
    meta: {
      model: "opus",
      subagent: { sessionId: "child", state: "running", canCancel: true, ...facts },
    },
    ...over,
  };
}

function controls(over: Partial<SubagentControls> = {}): SubagentControls {
  return { stop: vi.fn(), waiting: new Set(), showRequest: vi.fn(), ...over };
}

function renderCard(item: ToolCallItem, value?: SubagentControls, map = new Map()) {
  return render(
    <SubagentControlsContext.Provider value={value}>
      <SubagentCard item={item} toolCallMap={map} />
    </SubagentControlsContext.Provider>,
  );
}

describe("SubagentCard", () => {
  it("stops the subagent itself, and says so until it reports back", () => {
    const value = controls();
    renderCard(subagent(), value);
    fireEvent.click(screen.getByRole("button", { name: "Stop Worker B" }));
    expect(value.stop).toHaveBeenCalledWith("child");
    expect(screen.queryByRole("button", { name: "Stop Worker B" })).toBeNull();
    expect(screen.getByText("Stopping…")).toBeInTheDocument();
  });

  it("offers no stop without a cancel grant, once finished, or outside a live session", () => {
    const value = controls();
    const { rerender } = renderCard(subagent({ canCancel: false }), value);
    expect(screen.queryByRole("button", { name: "Stop Worker B" })).toBeNull();
    rerender(
      <SubagentControlsContext.Provider value={value}>
        <SubagentCard
          item={subagent({ state: "idle", outcome: "done" }, { status: "completed" })}
          toolCallMap={new Map()}
        />
      </SubagentControlsContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: "Stop Worker B" })).toBeNull();
    rerender(<SubagentCard item={subagent()} toolCallMap={new Map()} />);
    expect(screen.queryByRole("button", { name: "Stop Worker B" })).toBeNull();
  });

  it("shows its checklist's progress in the header and the steps when opened", () => {
    renderCard(
      subagent(
        {},
        {
          plan: [
            { content: "Read the file", priority: "medium", status: "completed" },
            { content: "Write the fix", priority: "medium", status: "in_progress" },
            { content: "Run tests", priority: "medium", status: "pending" },
          ],
        },
      ),
    );
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(screen.getByText("Write the fix")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Worker B" }));
    expect(screen.getByText("Checklist (1/3)")).toBeInTheDocument();
    expect(screen.getByText("Run tests")).toBeInTheDocument();
  });

  it("counts its tool calls by kind once done, with the time only for a run it watched", () => {
    const read = {
      toolCallId: "child/1",
      title: "Read",
      kind: "read",
      status: "completed",
      content: [],
      locations: [],
    } as ToolCallItem;
    const bash = { ...read, toolCallId: "child/2", kind: "execute" } as ToolCallItem;
    const map = new Map([
      [read.toolCallId, read],
      [bash.toolCallId, bash],
    ]);
    const done = subagent(
      { state: "idle", outcome: "done", startedAt: 0, endedAt: 72_000 },
      { status: "completed", childToolCallIds: [read.toolCallId, bash.toolCallId] },
    );
    renderCard(done, undefined, map);
    expect(screen.getByText("1m 12s · 2 tool calls")).toBeInTheDocument();
    expect(screen.getByText("1 reads · 1 bash")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("says why it failed, and that it waits on the user", () => {
    const { unmount } = renderCard(
      subagent({ state: "idle", outcome: "failed", error: "Rate limited" }, { status: "error" }),
    );
    expect(screen.getByText("Rate limited")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    unmount();

    const value = controls({ waiting: new Set(["child"]) });
    renderCard(subagent(), value);
    expect(screen.getByText("Waiting for your approval")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Worker B" }));
    expect(value.showRequest).toHaveBeenCalledWith("child");
  });
});
