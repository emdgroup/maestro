import { useState, useEffect, useRef } from "react";
import { FileText, Terminal, Box, ChevronDown, ChevronRight, Pencil, Search } from "lucide-react";
import type { ToolCallItem, ToolCallContent } from "./types";

const KIND_ICON: Record<string, React.ElementType> = {
  read_file: FileText,
  write_file: Pencil,
  edit_file: Pencil,
  create_file: Pencil,
  run_terminal: Terminal,
  bash: Terminal,
  shell: Terminal,
  search: Search,
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
  if (items.some((i) => i.status === "error")) return "error";
  if (items.some((i) => i.status === "in_progress")) return "in_progress";
  if (items.every((i) => i.status === "completed")) return "completed";
  return "pending";
}

function terminalSubtitle(items: ToolCallItem[]): string | null {
  if (items.length !== 1) return null;
  if (/run_terminal|bash|shell/.test(items[0].kind)) return items[0].title;
  return null;
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

  const statusText =
    status === "error"
      ? "Failed"
      : status === "completed"
        ? "Done"
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
    <div className={`rounded-lg border overflow-hidden ${isError ? "border-destructive/40" : "border-border"}`}>
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
          <span className="text-[11px] font-mono text-muted-foreground/60 truncate">{subtitle}</span>
        )}
        <span
          className={`ml-auto text-[10px] font-medium shrink-0 ${
            isError
              ? "text-destructive"
              : status === "completed"
                ? "text-muted-foreground"
                : "text-blue-400"
          }`}
        >
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
            const isReadFile = tc.kind === "read_file";
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
                  } ${isExpanded ? "bg-muted/20" : ""}`}
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
                  <div className="px-3 pb-2.5 pt-1.5 bg-muted/10 space-y-1.5 border-t border-border/40">
                    {tc.content.map((c, i) => (
                      <ToolCallContentBlock key={i} content={c} />
                    ))}
                    {tc.status === "error" && tc.content.length === 0 && (
                      <span className="text-xs text-destructive italic">Tool call failed</span>
                    )}
                  </div>
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
    case "content":
      return (
        <pre className="text-[11px] bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
          {content.content.text}
        </pre>
      );
    case "diff":
      return <InlineDiffBlock path={content.path} oldText={content.oldText} newText={content.newText} />;
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

type DiffLineItem = { type: "add" | "del" | "ctx"; text: string };

function parseDiffLines(oldText: string | null, newText: string): DiffLineItem[] {
  const lines = newText.split("\n");
  const firstNonEmpty = lines.find((l) => l.trim() !== "") ?? "";

  if (
    firstNonEmpty.startsWith("--- ") ||
    firstNonEmpty.startsWith("+++ ") ||
    firstNonEmpty.startsWith("@@ ") ||
    firstNonEmpty.startsWith("diff ")
  ) {
    return lines
      .filter((l, i) => !(i === lines.length - 1 && l === ""))
      .map((line) => ({
        type: (
          line.startsWith("+") && !line.startsWith("+++")
            ? "add"
            : line.startsWith("-") && !line.startsWith("---")
              ? "del"
              : "ctx"
        ) as DiffLineItem["type"],
        text: line,
      }));
  }

  if (oldText === null) {
    return lines
      .filter((l, i) => !(i === lines.length - 1 && l === ""))
      .map((line) => ({ type: "add" as const, text: `+${line}` }));
  }

  return [
    ...oldText.split("\n").map((line) => ({ type: "del" as const, text: `-${line}` })),
    ...lines.filter((l, i) => !(i === lines.length - 1 && l === "")).map((line) => ({ type: "add" as const, text: `+${line}` })),
  ];
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
                ? "bg-green-950/50 text-green-400 px-2.5 leading-relaxed whitespace-pre"
                : line.type === "del"
                  ? "bg-red-950/50 text-red-400 px-2.5 leading-relaxed whitespace-pre"
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
