import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// An expanded command label reaches for the theme to pick a shiki palette.
vi.mock("@/providers/ThemeProvider", () => ({ useTheme: () => ({ theme: "dark" }) }));

import { ActivityToolCallGroup } from "./ActivityToolCallGroup";
import { ToolCallTimeline } from "./ToolCallTimeline";
import type { ToolCallItem } from "./types";

const BODY = "SEVEN-HUNDRED-LINE-OUTPUT";

function call(id: string, title: string, kind = "read"): ToolCallItem {
  return {
    toolCallId: id,
    title,
    kind,
    status: "completed",
    // Unfenced, so ToolCallContentBlock takes its plain branch and shiki stays out.
    content: [{ type: "content", content: { type: "text", text: `${BODY} ${id}` } }],
    locations: [],
    meta: { toolName: "Read", fileTotalLines: 700 },
  };
}

const items = [call("a", "Read one.ts"), call("b", "Read two.ts"), call("c", "Read three.ts")];

/**
 * The stream holds every tool call of a session, so a collapsed row must cost a
 * line and nothing else — output kept out of the document, not hidden with CSS.
 */
describe("tool call output is built only when open", () => {
  it("keeps every body out of the DOM while the group is closed", () => {
    const { container } = render(<ActivityToolCallGroup items={items} />);
    expect(container.textContent).not.toContain(BODY);
    expect(container.querySelectorAll("pre").length).toBe(0);
  });

  it("builds only the row the user opened, not its siblings", () => {
    const { container } = render(<ToolCallTimeline items={items} />);
    expect(container.querySelectorAll("pre").length).toBe(0);

    fireEvent.click(screen.getByText(/two\.ts/));
    expect(container.querySelectorAll("pre").length).toBe(1);
    expect(container.textContent).toContain(`${BODY} b`);
    expect(container.textContent).not.toContain(`${BODY} a`);
    expect(container.textContent).not.toContain(`${BODY} c`);
  });

  it("tears the body back down on collapse", () => {
    const { container } = render(<ToolCallTimeline items={items} />);
    fireEvent.click(screen.getByText(/two\.ts/));
    expect(container.querySelectorAll("pre").length).toBe(1);

    fireEvent.click(screen.getByText(/two\.ts/));
    expect(container.querySelectorAll("pre").length).toBe(0);
    expect(container.textContent).not.toContain(BODY);
  });

  it("opens a lone row straight to its content, and only that row", () => {
    const { container } = render(<ToolCallTimeline items={[items[0]]} />);
    expect(container.querySelectorAll("pre").length).toBe(1);
  });
});
