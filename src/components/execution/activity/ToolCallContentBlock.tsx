import { Component } from "react";
import type { ReactNode } from "react";
import { MarkdownBlock } from "./MarkdownBlock";
import type { ToolCallContent } from "./types";

export class ContentErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="text-xs text-destructive italic px-2 py-1">
          Failed to render content: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Tool results are machine output — stdout, grep hits, file contents — and
 * markdown mangles them: soft newlines collapse into spaces, `#` becomes a
 * heading, `$` becomes KaTeX. Only text an agent deliberately fenced is treated
 * as markdown.
 *
 * ponytail: an opening fence at line start is the whole test — no matching
 * close, no streaming-aware state. Output that merely *contains* a fence line
 * (a grep over a markdown file) renders as markdown; tighten to a matched pair
 * if that shows up in practice.
 */
export function hasCodeFence(text: string): boolean {
  return /^ {0,3}(?:`{3,}|~{3,})/m.test(text);
}

/**
 * A fence wrapping the *entire* output is the agent framing its own text, not
 * markdown a human wrote — and rendering it as markdown draws a second box
 * inside the card that already frames it. Returns the text without its fence.
 *
 * The declared language is dropped with it. Tool output labels itself `console`
 * or nothing at all, neither of which is a grammar we bundle, and a read excerpt
 * arrives with line-number prefixes that no grammar parses anyway.
 *
 * Anything else (prose around a fence, several fences) is left to the markdown
 * renderer, where the box is the point.
 */
export function unwrapWholeFence(text: string): string | null {
  const match = /^\s*(`{3,}|~{3,})([^\n`]*)\n([\s\S]*?)\n?\1[ \t]*$/.exec(text);
  if (!match) return null;
  const inner = match[3];
  // A fence *inside* means the outer one was not the agent's own framing.
  return hasCodeFence(inner) ? null : inner;
}

export function ToolCallContentBlock({ content }: { content: ToolCallContent }) {
  switch (content.type) {
    case "content": {
      const text = content.content?.text;
      if (!text) return null;
      const bare = unwrapWholeFence(text);
      // The `[&_pre]:` rules carry the same wrapping into the fenced branch,
      // where the `pre` is shiki's and out of reach. `!` because they land on an
      // ancestor of shiki's own `[&_pre]:overflow-x-auto`: specificity ties, so
      // stylesheet order would otherwise pick the winner. The cost is column
      // alignment on lines wider than the panel — carets under a compiler error,
      // ASCII tables — which is the cheaper of the two.
      return (
        <div className="max-h-64 overflow-y-auto custom-scrollbar text-[11px] [&_pre]:overflow-x-visible! [&_pre]:break-words [&_pre]:whitespace-pre-wrap">
          {bare != null ? (
            <pre className="font-mono text-[11px] break-words whitespace-pre-wrap">{bare}</pre>
          ) : hasCodeFence(text) ? (
            <MarkdownBlock text={text} />
          ) : (
            // Wraps rather than scrolling sideways: a horizontal scrollbar nested
            // in this vertical scroller sits below the fold and cannot be reached.
            <pre className="font-mono text-[11px] break-words whitespace-pre-wrap">{text}</pre>
          )}
        </div>
      );
    }
    case "diff": {
      const newText = (
        content as { type: "diff"; path: string; oldText: string | null; newText?: string }
      ).newText;
      if (newText == null) return null;
      return <InlineDiffBlock path={content.path} oldText={content.oldText} newText={newText} />;
    }
    case "terminal":
      return (
        <div className="text-[11px] text-muted-foreground font-mono bg-muted/50 rounded px-2 py-1">
          Terminal output — see terminal tab
        </div>
      );
    default:
      return null;
  }
}

const DIFF_LINE_CAP = 200;

type DiffLineItem = { type: "add" | "del" | "ctx" | "truncated"; text: string };

function parseDiffLines(oldText: string | null, newText: string): DiffLineItem[] {
  if (newText == null) return [];

  const lines = newText.split("\n");
  const firstNonEmpty = lines.find((l) => l.trim() !== "") ?? "";

  let result: DiffLineItem[];

  if (
    firstNonEmpty.startsWith("--- ") ||
    firstNonEmpty.startsWith("+++ ") ||
    firstNonEmpty.startsWith("@@ ") ||
    firstNonEmpty.startsWith("diff ")
  ) {
    result = lines
      .filter((l, i) => !(i === lines.length - 1 && l === ""))
      .map((line) => ({
        type: (line.startsWith("+") && !line.startsWith("+++")
          ? "add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "del"
            : "ctx") as DiffLineItem["type"],
        text: line,
      }));
  } else if (oldText == null) {
    result = lines
      .filter((l, i) => !(i === lines.length - 1 && l === ""))
      .map((line) => ({ type: "add" as const, text: `+${line}` }));
  } else {
    result = [
      ...oldText.split("\n").map((line) => ({ type: "del" as const, text: `-${line}` })),
      ...lines
        .filter((l, i) => !(i === lines.length - 1 && l === ""))
        .map((line) => ({ type: "add" as const, text: `+${line}` })),
    ];
  }

  if (result.length > DIFF_LINE_CAP) {
    return [
      ...result.slice(0, DIFF_LINE_CAP),
      { type: "truncated", text: `… ${result.length - DIFF_LINE_CAP} more lines` },
    ];
  }
  return result;
}

function InlineDiffBlock({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText: string | null;
  newText: string;
}) {
  const lines = parseDiffLines(oldText, newText);
  return (
    <div className="rounded overflow-hidden border border-border font-mono text-[11px]">
      {path && (
        <div className="px-2.5 py-0.5 bg-muted text-muted-foreground/70 text-[10px] border-b border-border">
          {path}
        </div>
      )}
      <div className="overflow-x-auto max-h-52 overflow-y-auto custom-scrollbar">
        {lines.map((line, i) => (
          <div
            key={i}
            className={
              line.type === "add"
                ? "bg-diff-add-bg text-diff-add-fg px-2.5 leading-relaxed whitespace-pre"
                : line.type === "del"
                  ? "bg-diff-del-bg text-diff-del-fg px-2.5 leading-relaxed whitespace-pre"
                  : line.type === "truncated"
                    ? "text-muted-foreground/50 px-2.5 leading-relaxed italic text-[10px]"
                    : "text-muted-foreground/50 px-2.5 leading-relaxed whitespace-pre"
            }
          >
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}
