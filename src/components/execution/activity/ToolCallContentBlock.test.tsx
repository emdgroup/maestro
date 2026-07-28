import { render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// Importing this module pulls in MarkdownBlock, which reaches for katex's CSS
// and the theme provider that shiki reads.
vi.mock("@/providers/ThemeProvider", () => ({ useTheme: () => ({ theme: "dark" }) }));
vi.mock("katex/dist/katex.min.css", () => ({}));

import { hasCodeFence, unwrapWholeFence, ToolCallContentBlock } from "./ToolCallContentBlock";
import type { ToolCallContent } from "./types";

function textContent(text: string): ToolCallContent {
  return { type: "content", content: { type: "text", text } };
}

const GREP_OUTPUT = [
  "src/a.tsx:11:vi.mock('@/providers/ThemeProvider')",
  "src/a.tsx:12-import { foo } from './foo'",
  "src/b.tsx:3:export function Bar() {}",
].join("\n");

describe("hasCodeFence", () => {
  it("is false for plain multi-line tool output", () => {
    expect(hasCodeFence(GREP_OUTPUT)).toBe(false);
  });

  it("is false for inline backticks", () => {
    expect(hasCodeFence("run `bun run test` first\nthen `bun run lint`")).toBe(false);
  });

  it("is true for a fence at the start of a line", () => {
    expect(hasCodeFence("Result:\n```ts\nconst a = 1;\n```")).toBe(true);
  });

  it("is true for a tilde fence and for up to three spaces of indent", () => {
    expect(hasCodeFence("~~~\nx\n~~~")).toBe(true);
    expect(hasCodeFence("   ```\nx\n```")).toBe(true);
  });
});

describe("unwrapWholeFence", () => {
  // What a Read tool call actually sends: the whole excerpt inside one bare fence.
  const READ_OUTPUT = "```\n350\t}\n351\t\n352\t.shimmer-text {\n```";

  it("unwraps a bare fence that wraps the entire output", () => {
    expect(unwrapWholeFence(READ_OUTPUT)).toBe("350\t}\n351\t\n352\t.shimmer-text {");
  });

  it("unwraps a fence that declares a language too", () => {
    expect(unwrapWholeFence("```console\nerror TS6133\n```")).toBe("error TS6133");
  });

  it("leaves prose around a fence to the markdown renderer", () => {
    expect(unwrapWholeFence("Result:\n```ts\nconst a = 1;\n```")).toBeNull();
  });

  it("leaves a document that itself contains fences alone", () => {
    expect(unwrapWholeFence("````md\nintro\n```ts\nx\n```\n````")).toBeNull();
  });

  it("is null for plain output", () => {
    expect(unwrapWholeFence(GREP_OUTPUT)).toBeNull();
  });
});

describe("ToolCallContentBlock", () => {
  it("keeps line breaks in unfenced output", () => {
    const { container } = render(<ToolCallContentBlock content={textContent(GREP_OUTPUT)} />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe(GREP_OUTPUT);
  });

  it("still renders fenced output as markdown", () => {
    const { container } = render(
      <ToolCallContentBlock content={textContent("Result:\n```\nconst a = 1;\n```")} />,
    );
    expect(container.textContent).toContain("const a = 1;");
    expect(container.textContent).not.toContain("```");
  });
});
