import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { ActivityToolCallGroup } from "./ActivityToolCallGroup";
import type { ToolCallItem } from "./types";

function makeCall(
  toolCallId: string,
  title: string,
  status: ToolCallItem["status"],
  kind = "read",
): ToolCallItem {
  return {
    toolCallId,
    title,
    kind,
    status,
    // Content-free so ToolCallContentBlock (and shiki) never renders.
    content: [],
    locations: [],
  };
}

/** The collapsed line is always the first button; expanded rows follow it. */
function groupLine(): HTMLElement {
  return screen.getAllByRole("button")[0];
}

describe("ActivityToolCallGroup", () => {
  it("names the call in flight while running and collapsed", () => {
    render(
      <ActivityToolCallGroup
        items={[
          makeCall("a", "Read one.ts", "completed"),
          makeCall("b", "Read two.ts", "in_progress"),
        ]}
      />,
    );
    expect(screen.getByText(/two\.ts/)).toBeTruthy();
    expect(screen.queryByText(/2 tool calls/)).toBeNull();
  });

  it("treats a pending call as still running", () => {
    render(
      <ActivityToolCallGroup
        items={[makeCall("a", "Read one.ts", "completed"), makeCall("b", "Read two.ts", "pending")]}
      />,
    );
    expect(screen.getByText(/two\.ts/)).toBeTruthy();
  });

  it("switches to the summary when expanded mid-run, so only the row shimmers", () => {
    render(
      <ActivityToolCallGroup
        items={[makeCall("a", "Read one.ts", "error"), makeCall("b", "Read two.ts", "in_progress")]}
      />,
    );
    fireEvent.click(groupLine());
    expect(screen.getByText("2 tool calls")).toBeTruthy();
  });

  it("summarises once settled, counting an interrupted call as done", () => {
    render(
      <ActivityToolCallGroup
        items={[
          makeCall("a", "Read one.ts", "completed"),
          makeCall("b", "Read two.ts", "interrupted"),
        ]}
      />,
    );
    expect(screen.getByText("2 tool calls")).toBeTruthy();
  });

  it("keeps the title for a lone call", () => {
    render(<ActivityToolCallGroup items={[makeCall("a", "Read one.ts", "error")]} />);
    expect(screen.getByText(/one\.ts/)).toBeTruthy();
    expect(screen.queryByText(/1 tool call/)).toBeNull();
  });

  it("reports failures on the line without expanding", () => {
    render(
      <ActivityToolCallGroup
        items={[makeCall("a", "Read one.ts", "error"), makeCall("b", "Read two.ts", "completed")]}
      />,
    );
    expect(screen.getByText("· 1 failed")).toBeTruthy();
    expect(groupLine().getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles the timeline on click", () => {
    const items = [
      makeCall("a", "Read one.ts", "error"),
      makeCall("b", "Read two.ts", "completed"),
    ];
    render(<ActivityToolCallGroup items={items} />);

    fireEvent.click(groupLine());
    expect(groupLine().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/two\.ts/)).toBeTruthy();

    fireEvent.click(groupLine());
    expect(groupLine().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/two\.ts/)).toBeNull();
  });

  it("stays expanded when a later call streams in", () => {
    const items = [makeCall("a", "Read one.ts", "error")];
    const { rerender } = render(<ActivityToolCallGroup items={items} />);

    fireEvent.click(groupLine());
    expect(groupLine().getAttribute("aria-expanded")).toBe("true");

    rerender(
      <ActivityToolCallGroup items={[...items, makeCall("b", "Read two.ts", "in_progress")]} />,
    );
    expect(groupLine().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("2 tool calls")).toBeTruthy();
  });

  it("renders a group with nothing to open as plain text", () => {
    render(
      <ActivityToolCallGroup items={[makeCall("a", "Plan mode", "completed", "switch_mode")]} />,
    );
    expect(screen.getByText(/Plan/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
