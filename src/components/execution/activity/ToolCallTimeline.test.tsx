import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// An expanded command label reaches for the theme to pick a shiki palette.
vi.mock("@/providers/ThemeProvider", () => ({ useTheme: () => ({ theme: "dark" }) }));

import { McpIcon } from "@/components/common/icons/McpIcon";
import { ActivityToolCallGroup } from "./ActivityToolCallGroup";
import { OpenFileContext } from "./MarkdownBlock";
import {
  formatMcpToolName,
  isGitCommand,
  rowIcon,
  rowLabel,
  splitTitleAroundPath,
  ToolCallTimeline,
} from "./ToolCallTimeline";
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

describe("isGitCommand", () => {
  it("sees git wherever a command can start", () => {
    expect(isGitCommand("git status")).toBe(true);
    expect(isGitCommand("cd C:/repo && git add -A && git commit -q")).toBe(true);
    expect(isGitCommand("git push -q 2>&1 | tail -2; git log --oneline -2")).toBe(true);
    expect(isGitCommand("cd ../wt && gh pr create --base main")).toBe(true);
  });

  it("ignores git as a word inside a command", () => {
    expect(isGitCommand("cat .gitignore")).toBe(false);
    expect(isGitCommand("grep -r git README.md")).toBe(false);
    expect(isGitCommand("bun run test")).toBe(false);
  });

  it("marks a git command as a repository row, not a shell one", () => {
    const shell = (title: string): ToolCallItem => ({
      ...call("g", title, "execute"),
      meta: { toolName: "Bash", description: "Commit and push" },
    });
    expect(rowIcon(shell("cd C:/repo && git commit -q && git push"))).toBe(
      rowIcon({ ...call("x", "x"), meta: { git: { commitSha: "abc" } } }),
    );
    expect(rowIcon(shell("bun run test"))).not.toBe(rowIcon(shell("git status")));
  });
});

describe("formatMcpToolName", () => {
  it("reads an MCP tool as what it does, and where from", () => {
    expect(formatMcpToolName("mcp__chrome-devtools__take_screenshot")).toBe(
      "Take screenshot (chrome-devtools)",
    );
    expect(formatMcpToolName("mcp__context7__query-docs")).toBe("Query docs (context7)");
  });

  it("drops the server's name where its tool repeats it", () => {
    expect(formatMcpToolName("mcp__codegraph__codegraph_explore")).toBe("Explore (codegraph)");
    // A server with one tool named after itself: say it once, not twice.
    expect(formatMcpToolName("mcp__codegraph__codegraph")).toBe("Codegraph");
  });

  it("splits a tool's own words on either separator its author chose", () => {
    expect(formatMcpToolName("mcp__acme__take_screenshot")).toBe("Take screenshot (acme)");
    expect(formatMcpToolName("mcp__acme__take-screenshot")).toBe("Take screenshot (acme)");
    // The server keeps its hyphen — that is its name, not a word break.
    expect(formatMcpToolName("mcp__chrome-devtools__list_pages")).toBe(
      "List pages (chrome-devtools)",
    );
  });

  it("marks an MCP row with the protocol's own icon, from the title alone", () => {
    const mcp = call("m", "mcp__codegraph__codegraph_explore", "other");
    expect(rowIcon({ ...mcp, meta: {} })).toBe(McpIcon);
    expect(rowIcon({ ...mcp, meta: { toolName: "mcp__codegraph__codegraph_explore" } })).toBe(
      McpIcon,
    );
    expect(rowIcon(call("r", "Read one.ts"))).not.toBe(McpIcon);
  });

  it("unwraps a plugin-hosted server", () => {
    expect(formatMcpToolName("mcp__plugin_context7_context7__resolve-library-id")).toBe(
      "Resolve library id (context7)",
    );
  });

  it("leaves anything that is not a wire name alone", () => {
    expect(formatMcpToolName("Read src/a.ts")).toBeNull();
    expect(formatMcpToolName("mcp__nosuffix")).toBeNull();
    expect(rowLabel(call("m", "Read one.ts"))).toBe("Read one.ts");
  });

  it("labels the row rather than the raw name", () => {
    expect(rowLabel(call("m", "mcp__codegraph__codegraph_explore", "other"))).toBe(
      "Explore (codegraph)",
    );
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

  /** The row itself is the toggle, so it is the outermost of the two controls. */
  const row = () => screen.getAllByRole("button")[0];

  it("shows the bare file name collapsed and the path once open", () => {
    const { container } = renderWithOpener(() => {});
    expect(screen.getByRole("button", { name: "ToolCallTimeline.tsx" })).toBeTruthy();
    expect(container.textContent).not.toContain("src/components/execution");

    fireEvent.click(row());
    expect(
      screen.getByRole("button", {
        name: "src/components/execution/activity/ToolCallTimeline.tsx",
      }),
    ).toBeTruthy();
  });

  it("puts the title's line range on the right rather than after the name", () => {
    renderWithOpener(() => {});
    const name = screen.getByRole("button", { name: "ToolCallTimeline.tsx" });
    expect(name.textContent).not.toContain("(60 - 89)");
    // Right-hand slot, beside the rest of the row's detail.
    expect(screen.getByText("(60 - 89)").parentElement?.textContent).toContain("700 lines");
  });

  it("opens the file rather than the row when the name is clicked", () => {
    const onOpen = vi.fn();
    renderWithOpener(onOpen);

    fireEvent.click(screen.getByRole("button", { name: "ToolCallTimeline.tsx" }));
    expect(onOpen).toHaveBeenCalledWith(read.meta!.filePath);
    // Still closed: the name is not the toggle.
    expect(row().getAttribute("aria-expanded")).toBe("false");
  });

  it("expands from the label, not only the chevron — and not from the detail", () => {
    renderWithOpener(() => {});
    fireEvent.click(screen.getByText("700 lines"));
    expect(row().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByText("Read"));
    expect(row().getAttribute("aria-expanded")).toBe("true");
  });

  it("stays plain text where nothing can open a file, such as the side panel", () => {
    render(<ActivityToolCallGroup items={[read]} />);
    expect(screen.queryByRole("button", { name: "ToolCallTimeline.tsx" })).toBeNull();
  });
});
