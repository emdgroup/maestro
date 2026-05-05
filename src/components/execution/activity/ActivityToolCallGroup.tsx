import { useState, useEffect, useRef, Component } from "react";
import type { ReactNode } from "react";
import {
  FileText,
  Terminal,
  Box,
  ChevronDown,
  ChevronRight,
  Pencil,
  Search,
  Loader2,
  Trash2,
  Globe,
  Brain,
  ArrowRightLeft,
  Settings2,
} from "lucide-react";
import type { ToolCallItem, ToolCallContent } from "./types";

const KIND_ICON: Record<string, React.ElementType> = {
  // ACP SDK ToolKind values
  read: FileText,
  edit: Pencil,
  delete: Trash2,
  move: ArrowRightLeft,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
  switch_mode: Settings2,
  // Legacy/custom kinds
  read_file: FileText,
  write_file: Pencil,
  edit_file: Pencil,
  create_file: Pencil,
  run_terminal: Terminal,
  bash: Terminal,
  shell: Terminal,
};

function groupLabel(items: ToolCallItem[]): string {
  const n = items.length;
  if (n === 0) return "Tool calls";
  const kind = items[0].kind;
  const allSameKind = items.every((i) => i.kind === kind);
  if (!allSameKind) return `${n} tool calls`;
  if (/read_file/.test(kind)) return `Read ${n} file${n > 1 ? "s" : ""}`;
  if (/write_file/.test(kind)) return `Wrote ${n} file${n > 1 ? "s" : ""}`;
  if (/edit_file/.test(kind)) return `Edited ${n} file${n > 1 ? "s" : ""}`;
  if (/create_file/.test(kind)) return `Created ${n} file${n > 1 ? "s" : ""}`;
  if (/run_terminal|bash|shell/.test(kind)) return n === 1 ? "Run command" : `Ran ${n} commands`;
  return n === 1 ? items[0].title : `${n} tool calls`;
}

function groupStatus(items: ToolCallItem[]): ToolCallItem["status"] {
  if (items.some((i) => i.status === "in_progress")) return "in_progress";
  if (items.every((i) => i.status === "completed")) return "completed";
  if (items.every((i) => i.status === "error")) return "error";
  if (items.every((i) => i.status === "completed" || i.status === "error")) return "completed";
  return "pending";
}

function terminalSubtitle(items: ToolCallItem[]): string | null {
  if (items.length !== 1) return null;
  if (/run_terminal|bash|shell/.test(items[0].kind)) return items[0].title;
  return null;
}

class ContentErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
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

interface ActivityToolCallGroupProps {
  items: ToolCallItem[];
}

export function ActivityToolCallGroup({ items }: ActivityToolCallGroupProps) {
  const allDone = items.every((i) => i.status === "completed" || i.status === "error");
  const [groupOpen, setGroupOpen] = useState(!allDone);
  const userToggled = useRef(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!userToggled.current && allDone) {
      setGroupOpen(false);
    }
  }, [allDone]);

  const status = groupStatus(items);
  const isError = status === "error";
  const Icon = KIND_ICON[items[0]?.kind] ?? Box;
  const label = groupLabel(items);
  const subtitle = terminalSubtitle(items);
  const errorCount = items.filter((i) => i.status === "error").length;

  const statusText =
    status === "error"
      ? "Failed"
      : status === "completed"
        ? errorCount > 0
          ? `Done (${errorCount} failed)`
          : "Done"
        : status === "in_progress"
          ? "Running"
          : "Pending";

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      className={`rounded-lg border overflow-hidden ${isError ? "border-destructive/40" : "border-border"}`}
    >
      <button
        type="button"
        onClick={() => {
          userToggled.current = true;
          setGroupOpen((v) => !v);
        }}
        className="flex items-center gap-2 w-full px-3 py-2 bg-card hover:bg-muted/50 transition-colors text-left"
      >
        <Icon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground/80">{label}</span>
        {subtitle && (
          <span className="text-[11px] font-mono text-muted-foreground/60 truncate">
            {subtitle}
          </span>
        )}
        <span
          className={`ml-auto flex items-center gap-1 text-[10px] font-medium shrink-0 ${
            isError
              ? "text-destructive"
              : status === "completed"
                ? "text-muted-foreground"
                : "text-secondary"
          }`}
        >
          {status === "in_progress" && <Loader2 className="w-3 h-3 animate-spin" />}
          {statusText}
        </span>
        {groupOpen ? (
          <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground" />
        )}
      </button>

      {groupOpen && (
        <div className="border-t border-border divide-y divide-border/40">
          {items.map((tc) => {
            const CardIcon = KIND_ICON[tc.kind] ?? Box;
            const isReadFile = tc.kind === "read_file" || tc.kind === "read";
            const hasContent = !isReadFile && tc.content.length > 0;
            const isExpanded = expandedIds.has(tc.toolCallId);

            return (
              <div key={tc.toolCallId}>
                <button
                  type="button"
                  disabled={!hasContent}
                  onClick={() => hasContent && toggleExpand(tc.toolCallId)}
                  className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors ${
                    hasContent ? "cursor-pointer hover:bg-muted/30" : "cursor-default"
                  } ${isExpanded ? "bg-muted/20" : ""} ${tc.status === "in_progress" ? "animate-pulse" : ""}`}
                >
                  <CardIcon
                    className={`w-3.5 h-3.5 shrink-0 ${
                      tc.status === "error" ? "text-destructive" : "text-muted-foreground"
                    }`}
                  />
                  <span
                    className={`font-medium truncate flex-1 ${
                      tc.status === "error" ? "text-destructive" : "text-foreground/80"
                    }`}
                  >
                    {tc.title}
                  </span>
                  {tc.status === "error" && (
                    <span className="text-[10px] text-destructive shrink-0">Failed</span>
                  )}
                </button>
                {isExpanded && (
                  <ContentErrorBoundary>
                    <div className="px-3 pb-2.5 pt-1.5 bg-muted/10 space-y-1.5 border-t border-border/40">
                      {tc.content.map((c, i) => (
                        <ToolCallContentBlock key={i} content={c} />
                      ))}
                      {tc.status === "error" && tc.content.length === 0 && (
                        <span className="text-xs text-destructive italic">Tool call failed</span>
                      )}
                    </div>
                  </ContentErrorBoundary>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ToolCallContentBlock({ content }: { content: ToolCallContent }) {
  switch (content.type) {
    case "content": {
      const text = content.content?.text;
      if (!text) return null;
      return (
        <pre className="text-[11px] bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
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
      <div className="overflow-x-auto max-h-52 overflow-y-auto">
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
