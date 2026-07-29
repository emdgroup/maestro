import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// An expanded command label reaches for the theme to pick a shiki palette.
vi.mock("@/providers/ThemeProvider", () => ({ useTheme: () => ({ theme: "dark" }) }));

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

/** A command call with output, so the group is expandable. */
function makeCommandCall(title: string): ToolCallItem {
  return {
    ...makeCall("cmd", title, "completed", "execute"),
    content: [{ type: "content", content: { type: "text", text: "ok" } }],
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
    expect(screen.getByText("2 files read")).toBeTruthy();
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
    expect(screen.getByText("2 files read")).toBeTruthy();
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
    expect(screen.getByText("2 files read")).toBeTruthy();
  });

  it("treats execute/bash/shell aliases as the same category", () => {
    render(
      <ActivityToolCallGroup
        items={[
          makeCall("a", "Run tests", "completed", "execute"),
          makeCall("b", "Install deps", "completed", "bash"),
        ]}
      />,
    );
    expect(screen.getByText("2 commands executed")).toBeTruthy();
  });

  it("shows an expanded command once — as the label, not a label plus an echo", () => {
    const cmd = "bun run test --reporter=verbose src/foo.test.ts";
    const { container } = render(<ActivityToolCallGroup items={[makeCommandCall(cmd)]} />);

    // textContent is the flattened text, so each character is counted once.
    const count = () => container.textContent!.split(cmd).length - 1;
    expect(count()).toBe(1);

    fireEvent.click(groupLine());
    expect(groupLine().getAttribute("aria-expanded")).toBe("true");
    expect(count()).toBe(1);
  });

  it("opens a call whose only output came as rawOutput", () => {
    const tc: ToolCallItem = {
      ...makeCall("a", "Edit index.css", "completed", "edit"),
      meta: { output: "The file src/index.css has been updated successfully." },
    };
    render(<ActivityToolCallGroup items={[tc]} />);
    fireEvent.click(groupLine());
    expect(screen.getByText(/updated successfully/)).toBeTruthy();
  });

  it("says a refused call was blocked, not that it failed", () => {
    const tc: ToolCallItem = {
      ...makeCall("a", "Bash rmdir /s /q", "error", "execute"),
      meta: { blocked: true, errorText: "[Irreversible Local Destruction] mirrors a junction" },
    };
    render(<ActivityToolCallGroup items={[tc]} />);
    fireEvent.click(groupLine());
    expect(screen.getByText(/Irreversible Local Destruction/)).toBeTruthy();
    expect(screen.queryByText("Failed")).toBeNull();
  });

  it("splits a summary by tool when one kind covers two of them", () => {
    const edit = (id: string, toolName: string): ToolCallItem => ({
      ...makeCall(id, `${toolName} a.ts`, "completed", "edit"),
      meta: { toolName },
    });
    render(
      <ActivityToolCallGroup items={[edit("a", "Edit"), edit("b", "Edit"), edit("c", "Write")]} />,
    );
    expect(screen.getByText("2 edited · 1 created")).toBeTruthy();
  });

  it("labels a command with why it ran, keeping the command for the open state", () => {
    const cmd = "git diff --stat -- src/components/execution/agent-monitor/AgentMonitor.tsx";
    const tc: ToolCallItem = {
      ...makeCommandCall(cmd),
      meta: { description: "Inspect possibly pre-existing changes" },
    };
    const { container } = render(<ActivityToolCallGroup items={[tc]} />);
    const count = () => container.textContent!.split(cmd).length - 1;
    expect(screen.getByText(/Inspect/)).toBeTruthy();
    expect(count()).toBe(0);

    fireEvent.click(groupLine());
    // The description keeps the header line; the command appears once, in the card.
    expect(screen.getByText(/Inspect/)).toBeTruthy();
    expect(count()).toBe(1);
  });

  it("opens a read to the excerpt the agent saw", () => {
    const tc: ToolCallItem = {
      ...makeCall("a", "Read ToolCallTimeline.tsx (60 - 62)", "completed", "read"),
      // Unfenced, so ToolCallContentBlock takes its plain branch and shiki stays out.
      content: [{ type: "content", content: { type: "text", text: "60\texport function" } }],
      meta: { toolName: "Read", fileTotalLines: 171 },
    };
    render(<ActivityToolCallGroup items={[tc]} />);
    // The row line reports the file's length, not the range already in the title.
    expect(screen.getByText("171 lines")).toBeTruthy();

    fireEvent.click(groupLine());
    expect(screen.getByText(/export function/)).toBeTruthy();
  });

  it("labels a search by what it looked for, not by its invented command line", () => {
    const tc: ToolCallItem = {
      ...makeCall(
        "a",
        'grep -n -C 4 "session_start_sha" C:\\Users\\me\\repo\\src-tauri',
        "completed",
        "search",
      ),
      meta: { toolName: "Grep", searchPattern: "session_start_sha", searchScope: "…/me/repo" },
    };
    // The bolded verb is its own span, so read the flattened line.
    const { container } = render(<ActivityToolCallGroup items={[tc]} />);
    expect(container.textContent).toBe('Search "session_start_sha" in …/me/repo');
  });

  it("renders a group with nothing to open as plain text", () => {
    render(
      <ActivityToolCallGroup items={[makeCall("a", "Plan mode", "completed", "switch_mode")]} />,
    );
    expect(screen.getByText(/Plan/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
