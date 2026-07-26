import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// Mock Tauri and heavy deps before importing component
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/shiki-highlighter", () => ({
  getDiffHighlighter: vi
    .fn()
    .mockResolvedValue({ codeToHtml: vi.fn().mockReturnValue("<code>mock</code>") }),
}));
vi.mock("@/providers/ThemeProvider", () => ({ useTheme: () => ({ theme: "dark" }) }));
vi.mock("katex/dist/katex.min.css", () => ({}));

import { ActivityMessageItem, getCompleteBlocksText } from "./ActivityMessageItem";
import { splitAtSectionStarts } from "./markdown-stream-utils";
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

  it("ignores double newline inside unclosed ~~~ fence", () => {
    const text = "Para\n\n~~~\nline1\n\nline2\n";
    expect(getCompleteBlocksText(text)).toBe("Para");
  });

  it("ignores double newline inside unclosed indented fence", () => {
    const text = "Para\n\n  ```js\nline1\n\nline2\n";
    expect(getCompleteBlocksText(text)).toBe("Para");
  });

  it("does not close a 4-backtick fence with a 3-backtick line", () => {
    const text = "Para\n\n````md\n```js\ncode\n```\n\nstill inside\n";
    expect(getCompleteBlocksText(text)).toBe("Para");
  });

  it("treats a matching-length close of a 4-backtick fence as complete", () => {
    const text = "Para\n\n````md\n```js\ncode\n```\n````\n\nNext";
    expect(getCompleteBlocksText(text)).toBe("Para\n\n````md\n```js\ncode\n```\n````");
  });
});

describe("splitAtSectionStarts", () => {
  it("keeps plain paragraphs as a single section", () => {
    expect(splitAtSectionStarts("Para1\n\nPara2\n\nPara3")).toEqual(["Para1\n\nPara2\n\nPara3"]);
  });

  it("cuts before a heading", () => {
    expect(splitAtSectionStarts("Intro\n\n# Title\n\nBody")).toEqual(["Intro", "# Title\n\nBody"]);
  });

  it("cuts before a top-level code fence", () => {
    expect(splitAtSectionStarts("Intro\n\n```js\nconst x = 1;\n```")).toEqual([
      "Intro",
      "```js\nconst x = 1;\n```",
    ]);
  });

  it("does not cut inside a code fence", () => {
    const text = "```md\nline\n\n# not a heading\n```\n\nAfter";
    expect(splitAtSectionStarts(text)).toEqual([text]);
  });

  it("does not cut a loose numbered list apart", () => {
    const text = "1. first\n\n2. second\n\n3. third";
    expect(splitAtSectionStarts(text)).toEqual([text]);
  });

  it("does not treat hashes without a space as a heading", () => {
    const text = "Para\n\n#hashtag not heading";
    expect(splitAtSectionStarts(text)).toEqual([text]);
  });

  it("does not cut inside a ~~~ fence", () => {
    const text = "~~~md\nline\n\n# not a heading\n~~~\n\nAfter";
    expect(splitAtSectionStarts(text)).toEqual([text]);
  });

  it("cuts before a ~~~ fence", () => {
    expect(splitAtSectionStarts("Intro\n\n~~~\ncode\n~~~")).toEqual(["Intro", "~~~\ncode\n~~~"]);
  });

  it("does not cut inside a 4-backtick fence containing ``` lines", () => {
    const text = "````md\n```js\ncode\n```\n\n# not a heading\n````\n\nAfter";
    expect(splitAtSectionStarts(text)).toEqual([text]);
  });

  it("keeps earlier sections stable as text grows", () => {
    const shorter = "Intro\n\n# One\n\nBody one";
    const longer = "Intro\n\n# One\n\nBody one\n\n# Two\n\nBody two";
    const before = splitAtSectionStarts(shorter);
    const after = splitAtSectionStarts(longer);
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
    expect(after).toEqual(["Intro", "# One\n\nBody one", "# Two\n\nBody two"]);
  });
});

describe("raw svg rendering", () => {
  // Note: lucide icons (copy button etc.) are also <svg>, so assertions use
  // viewBox-specific selectors rather than bare "svg".

  it("renders a raw <svg> between paragraphs as a graphic", () => {
    const text = 'Before\n\n<svg viewBox="0 0 10 10"><rect width="5" height="5" /></svg>\n\nAfter';
    const { container } = render(<ActivityMessageItem message={makeMessage(text)} />);
    const svg = container.querySelector('svg[viewBox="0 0 10 10"]');
    expect(svg).not.toBeNull();
    expect(svg!.querySelector("rect")).not.toBeNull();
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
  });

  it("preserves allowed presentation attributes through sanitization", () => {
    const text =
      '<svg viewBox="0 0 4 4"><path d="M0 0L4 4" stroke="red" stroke-width="2" stroke-linecap="round" /></svg>';
    const { container } = render(<ActivityMessageItem message={makeMessage(text)} />);
    const path = container.querySelector('svg[viewBox="0 0 4 4"] path');
    expect(path).not.toBeNull();
    expect(path!.getAttribute("stroke-width")).toBe("2");
    expect(path!.getAttribute("stroke-linecap")).toBe("round");
  });

  it("strips event handlers and script elements from raw svg", () => {
    const text =
      '<svg viewBox="0 0 8 8" onclick="alert(1)"><script>alert(2)</script><rect onmouseover="x()" /></svg>';
    const { container } = render(<ActivityMessageItem message={makeMessage(text)} />);
    const svg = container.querySelector('svg[viewBox="0 0 8 8"]');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("onclick")).toBeNull();
    expect(svg!.querySelector("script")).toBeNull();
    expect(svg!.querySelector("rect")?.getAttribute("onmouseover") ?? null).toBeNull();
  });

  it("does not render prose as an error blob when `<svg>` is mentioned inline before a fence containing </svg>", () => {
    const text =
      "That overlay `<svg>` contains only the arc circle, so rotating it wobbles.\n\n" +
      "The fix is to carry the origin over explicitly:\n\n" +
      '```tsx\n<svg viewBox="0 0 42 42">\n  <circle />\n</svg>\n```';
    const { container } = render(<ActivityMessageItem message={makeMessage(text)} />);
    expect(screen.getByText(/contains only the arc circle/)).toBeInTheDocument();
    expect(container.querySelector('svg[viewBox="0 0 42 42"]')).toBeNull();
    expect(container.querySelector(".text-destructive")).toBeNull();
  });

  it("keeps <svg> inside a ~~~ fence as code, not a graphic", () => {
    const text = '~~~\n<svg viewBox="0 0 9 9"><rect /></svg>\n~~~';
    const { container } = render(<ActivityMessageItem message={makeMessage(text)} />);
    expect(container.querySelector('svg[viewBox="0 0 9 9"]')).toBeNull();
  });

  it("keeps <svg> inside a blockquoted fence as code, not a graphic", () => {
    const text = '> ```html\n> <svg viewBox="0 0 9 9"></svg>\n> ```';
    const { container } = render(<ActivityMessageItem message={makeMessage(text)} />);
    expect(container.querySelector('svg[viewBox="0 0 9 9"]')).toBeNull();
  });

  it("keeps an inline `<svg></svg>` code span as code, not a graphic", () => {
    const text = "use `<svg></svg>` for that";
    render(<ActivityMessageItem message={makeMessage(text)} />);
    expect(screen.getByText("<svg></svg>")).toBeInTheDocument();
    expect(screen.getByText(/for that/)).toBeInTheDocument();
  });

  it("renders a real <svg> that follows a fenced code sample", () => {
    const text =
      '```html\n<svg viewBox="0 0 9 9"></svg>\n```\n\n<svg viewBox="0 0 3 3"><circle r="1" /></svg>';
    const { container } = render(<ActivityMessageItem message={makeMessage(text)} />);
    expect(container.querySelector('svg[viewBox="0 0 3 3"]')).not.toBeNull();
    expect(container.querySelector('svg[viewBox="0 0 9 9"]')).toBeNull();
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

    const cells = screen
      .getAllByRole("cell")
      .filter((c) => ["70", "80", "95"].includes(c.textContent ?? ""));
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

    const cells = screen
      .getAllByRole("cell")
      .filter((c) => ["70", "80", "95"].includes(c.textContent ?? ""));
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
