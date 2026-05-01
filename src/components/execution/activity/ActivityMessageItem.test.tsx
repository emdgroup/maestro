import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// Mock Tauri and heavy deps before importing component
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/shiki-highlighter", () => ({
  getDiffHighlighter: vi.fn().mockResolvedValue({ codeToHtml: vi.fn().mockReturnValue("<code>mock</code>") }),
}));
vi.mock("@/providers/ThemeProvider", () => ({ useTheme: () => ({ theme: "dark" }) }));
vi.mock("katex/dist/katex.min.css", () => ({}));

import { ActivityMessageItem, getCompleteBlocksText } from "./ActivityMessageItem";
import type { MessageItem } from "./types";

function makeMessage(text: string): MessageItem {
  return { id: "1", text, isStreaming: false };
}

describe("getCompleteBlocksText", () => {
  it("returns empty for empty string", () => {
    expect(getCompleteBlocksText("")).toBe("");
  });

  it("returns empty when no double newline", () => {
    expect(getCompleteBlocksText("Hello world")).toBe("");
    expect(getCompleteBlocksText("Hello\nworld")).toBe("");
  });

  it("returns first paragraph when two paragraphs", () => {
    expect(getCompleteBlocksText("Hello\n\nWorld")).toBe("Hello");
  });

  it("returns all complete paragraphs, excluding last incomplete", () => {
    expect(getCompleteBlocksText("Para1\n\nPara2\n\nPara3")).toBe("Para1\n\nPara2");
  });

  it("includes closed code fence as complete block", () => {
    const text = "```js\nconst x = 1;\n```\n\nNext paragraph";
    expect(getCompleteBlocksText(text)).toBe("```js\nconst x = 1;\n```");
  });

  it("returns empty for unclosed code fence", () => {
    const text = "```js\nconst x = 1;\n";
    expect(getCompleteBlocksText(text)).toBe("");
  });

  it("ignores double newline inside unclosed code fence", () => {
    const text = "```js\nline1\n\nline2\n";
    expect(getCompleteBlocksText(text)).toBe("");
  });

  it("returns text before unclosed fence when prior complete block exists", () => {
    const text = "Para1\n\nPara2\n\n```js\ncode without closing";
    expect(getCompleteBlocksText(text)).toBe("Para1\n\nPara2");
  });

  it("handles heading followed by paragraph", () => {
    const text = "# Heading\n\nParagraph\n\nIncomplete";
    expect(getCompleteBlocksText(text)).toBe("# Heading\n\nParagraph");
  });
});

describe("table sorting", () => {
  it("renders a GFM table with sortable headers", () => {
    const md = `
| Name | Age |
|------|-----|
| Alice | 30 |
| Bob | 25 |
`;
    render(<ActivityMessageItem message={makeMessage(md)} />);
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("sorts column ascending on first click", () => {
    const md = `
| Name | Score |
|------|-------|
| Charlie | 80 |
| Alice | 95 |
| Bob | 70 |
`;
    render(<ActivityMessageItem message={makeMessage(md)} />);

    fireEvent.click(screen.getByText("Score", { selector: "th span" }));

    const cells = screen.getAllByRole("cell").filter(c => ["70", "80", "95"].includes(c.textContent ?? ""));
    expect(cells[0].textContent).toBe("70");
    expect(cells[1].textContent).toBe("80");
    expect(cells[2].textContent).toBe("95");
  });

  it("reverses to descending on second click", () => {
    const md = `
| Name | Score |
|------|-------|
| Charlie | 80 |
| Alice | 95 |
| Bob | 70 |
`;
    render(<ActivityMessageItem message={makeMessage(md)} />);

    const scoreHeader = screen.getByText("Score", { selector: "th span" });
    fireEvent.click(scoreHeader);
    fireEvent.click(scoreHeader);

    const cells = screen.getAllByRole("cell").filter(c => ["70", "80", "95"].includes(c.textContent ?? ""));
    expect(cells[0].textContent).toBe("95");
    expect(cells[1].textContent).toBe("80");
    expect(cells[2].textContent).toBe("70");
  });

  it("sorts strings alphabetically", () => {
    const md = `
| Name |
|------|
| Charlie |
| Alice |
| Bob |
`;
    render(<ActivityMessageItem message={makeMessage(md)} />);

    fireEvent.click(screen.getByText("Name", { selector: "th span" }));

    const rows = screen.getAllByRole("row").slice(1); // skip header
    expect(rows[0].textContent).toContain("Alice");
    expect(rows[1].textContent).toContain("Bob");
    expect(rows[2].textContent).toContain("Charlie");
  });

  it("resets to original order when switching to a new column", () => {
    const md = `
| Name | Score |
|------|-------|
| Charlie | 80 |
| Alice | 95 |
| Bob | 70 |
`;
    render(<ActivityMessageItem message={makeMessage(md)} />);

    fireEvent.click(screen.getByText("Score", { selector: "th span" }));
    fireEvent.click(screen.getByText("Name", { selector: "th span" }));

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0].textContent).toContain("Alice");
  });
});
