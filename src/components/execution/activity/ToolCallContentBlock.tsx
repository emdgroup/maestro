import { Component } from "react";
import type { ReactNode } from "react";
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

export function ToolCallContentBlock({ content }: { content: ToolCallContent }) {
  switch (content.type) {
    case "content": {
      const text = content.content?.text;
      if (!text) return null;
      return (
        <pre className="text-[11px] bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-40 overflow-y-auto custom-scrollbar">
          {text}
        </pre>
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
          Terminal: {content.terminalId}
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
