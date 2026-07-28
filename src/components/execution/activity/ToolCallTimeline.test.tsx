import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// An expanded command label reaches for the theme to pick a shiki palette.
vi.mock("@/providers/ThemeProvider", () => ({ useTheme: () => ({ theme: "dark" }) }));

import { ActivityToolCallGroup } from "./ActivityToolCallGroup";
import { OpenFileContext } from "./MarkdownBlock";
import { splitTitleAroundPath, ToolCallTimeline } from "./ToolCallTimeline";
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

describe("splitTitleAroundPath", () => {
  it("finds the path inside an agent-written title", () => {
    expect(splitTitleAroundPath("Read src/a/b.ts (60 - 89)", "C:/repo/src/a/b.ts")).toEqual({
      before: "Read ",
      file: "src/a/b.ts",
      after: " (60 - 89)",
    });
  });

  it("matches a Windows path against a Windows title", () => {
    expect(splitTitleAroundPath("Edit src\\index.css", "C:\\repo\\src\\index.css")?.file).toBe(
      "src\\index.css",
    );
  });

  it("is null when the title never names the file", () => {
    expect(splitTitleAroundPath("Update the theme", "C:/repo/src/index.css")).toBeNull();
  });
});

/** A file row names its file, and the name is a link to it — not a toggle. */
describe("file rows", () => {
  const read: ToolCallItem = {
    ...call("f", "Read src/components/execution/activity/ToolCallTimeline.tsx (60 - 89)"),
    meta: {
      toolName: "Read",
      fileTotalLines: 700,
      filePath: "C:/repo/src/components/execution/activity/ToolCallTimeline.tsx",
    },
  };

  function renderWithOpener(onOpen: (uri: string) => void) {
    return render(
      <OpenFileContext.Provider value={onOpen}>
        <ActivityToolCallGroup items={[read]} />
      </OpenFileContext.Provider>,
    );
  }

  it("shows the bare file name collapsed and the path once open", () => {
    const { container } = renderWithOpener(() => {});
    expect(screen.getByRole("button", { name: "ToolCallTimeline.tsx" })).toBeTruthy();
    expect(container.textContent).not.toContain("src/components/execution");

    fireEvent.click(screen.getByRole("button", { name: "Show output" }));
    expect(
      screen.getByRole("button", {
        name: "src/components/execution/activity/ToolCallTimeline.tsx",
      }),
    ).toBeTruthy();
  });

  it("opens the file rather than the row when the name is clicked", () => {
    const onOpen = vi.fn();
    renderWithOpener(onOpen);

    fireEvent.click(screen.getByRole("button", { name: "ToolCallTimeline.tsx" }));
    expect(onOpen).toHaveBeenCalledWith(read.meta!.filePath);
    // Still closed: the name is not the toggle.
    expect(screen.getByRole("button", { name: "Show output" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("stays plain text where nothing can open a file, such as the side panel", () => {
    render(<ActivityToolCallGroup items={[read]} />);
    expect(screen.queryByRole("button", { name: "ToolCallTimeline.tsx" })).toBeNull();
  });
});
