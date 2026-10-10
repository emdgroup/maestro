import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/settings.service", () => ({ useSettings: () => ({ data: undefined }) }));

import { SubagentCard } from "./SubagentCard";
import { StopSubagentContext } from "./subagent-stop";
import type { ToolCallItem } from "./types";

function subagent(over: Partial<ToolCallItem> = {}): ToolCallItem {
  return {
    toolCallId: "agent",
    title: "Task",
    kind: "think",
    status: "in_progress",
    content: [],
    locations: [],
    rawInput: { description: "Worker B", prompt: "Run it." },
    meta: { background: true, agentId: "ad28291f" },
    ...over,
  };
}

function renderCard(item: ToolCallItem, stop?: (prompt: string) => void) {
  return render(
    <StopSubagentContext.Provider value={stop}>
      <SubagentCard item={item} toolCallMap={new Map()} />
    </StopSubagentContext.Provider>,
  );
}

describe("SubagentCard", () => {
  it("asks the main agent to stop a running background subagent, naming it by id", () => {
    const stop = vi.fn();
    renderCard(subagent(), stop);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stop).toHaveBeenCalledWith(
      "Stop the background subagent 'Worker B' (task id ad28291f) now. Leave any other subagents running.",
    );
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  });

  it("offers no stop for a foreground subagent, a finished one, or outside a live session", () => {
    const stop = vi.fn();
    const { rerender } = renderCard(subagent({ meta: {} }), stop);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    rerender(
      <StopSubagentContext.Provider value={stop}>
        <SubagentCard item={subagent({ status: "completed" })} toolCallMap={new Map()} />
      </StopSubagentContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    rerender(<SubagentCard item={subagent()} toolCallMap={new Map()} />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("reads Stopped once a background subagent is interrupted", () => {
    renderCard(subagent({ status: "interrupted" }));
    expect(screen.getAllByText("Stopped")).toHaveLength(2);
  });
});
