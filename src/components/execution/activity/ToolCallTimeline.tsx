import { useState } from "react";
import {
  ArrowRightLeft,
  Box,
  Brain,
  FileText,
  Globe,
  Pencil,
  Search,
  Settings2,
  Terminal,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { CommandLabel } from "./CommandLabel";
import { ContentErrorBoundary, ToolCallContentBlock } from "./ToolCallContentBlock";
import type { ToolCallItem } from "./types";

export const KIND_ICON: Record<string, React.ElementType> = {
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
  // legacy/custom kinds
  read_file: FileText,
  write_file: Pencil,
  edit_file: Pencil,
  create_file: Pencil,
  run_terminal: Terminal,
  bash: Terminal,
  shell: Terminal,
};

export function isTerminalKind(kind: string) {
  return /run_terminal|bash|shell|execute/.test(kind);
}

/** A row is worth opening when it has content to show, or failed and owes an explanation. */
export function hasRowContent(tc: ToolCallItem): boolean {
  if (tc.status === "error") return true;
  const isReadFile = tc.kind === "read_file" || tc.kind === "read";
  return !isReadFile && tc.content.length > 0;
}

export function isRunning(tc: ToolCallItem): boolean {
  return tc.status === "pending" || tc.status === "in_progress";
}

/**
 * Renders the first word in bold. Titles are agent-supplied free text and
 * conventionally lead with the action ("Read foo.ts", "Grep KIND_ICON"), so the
 * split is on the title itself rather than a verb derived from `kind`.
 */
export function ToolCallTitle({ title, className }: { title: string; className?: string }) {
  const space = title.indexOf(" ");
  if (space < 1) return <span className={className}>{title}</span>;
  return (
    <span className={className}>
      <span className="font-semibold">{title.slice(0, space)}</span>
      {title.slice(space)}
    </span>
  );
}

/** The kind icon doubles as the rail's status marker, so it carries the colour. */
function statusIcon(tc: ToolCallItem): string {
  if (isRunning(tc)) return "text-secondary animate-pulse";
  if (tc.status === "error") return "text-destructive";
  if (tc.status === "interrupted") return "text-warning/60";
  return "text-muted-foreground";
}

/**
 * Vertical rail of tool calls, one fit-content row each, every row expanding to
 * its own content. Shared by ActivityToolCallGroup and SubagentCard — keep it at
 * a single prop; a second one means the seam is in the wrong place.
 *
 * `inline` — when the parent already shows the single item's title as a group
 * header, skip the redundant inner title row and render content directly.
 */
export function ToolCallTimeline({ items, inline }: { items: ToolCallItem[]; inline?: boolean }) {
  // A lone call opens straight to its content, so it stays a one-click read.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(items.length === 1 && hasRowContent(items[0]) ? [items[0].toolCallId] : []),
  );

  // Inline single-item path: parent header is the toggle, render content directly.
  // Must come after all hook calls.
  if (inline && items.length === 1) {
    const tc = items[0];
    return (
      <ContentErrorBoundary>
        {/* No command echo here: the group header renders it as the expanded label. */}
        <div className="space-y-1.5 pt-1 pb-1.5 pl-1">
          {tc.content.map((c, i) => (
            <ToolCallContentBlock key={i} content={c} />
          ))}
          {tc.status === "error" && tc.content.length === 0 && (
            <span className="text-xs text-destructive italic">Tool call failed</span>
          )}
        </div>
      </ContentErrorBoundary>
    );
  }

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div>
      {items.map((tc, i) => {
        const Icon = KIND_ICON[tc.kind] ?? Box;
        const hasContent = hasRowContent(tc);
        const isExpanded = expandedIds.has(tc.toolCallId);
        const running = isRunning(tc);
        const isLast = i === items.length - 1;
        // Expanded, the label stops being a truncated summary and becomes the
        // command in full — so the row never shows the same string twice.
        const showCommand = isExpanded && isTerminalKind(tc.kind) && !!tc.title;

        return (
          // The rail is a flex column beside the row rather than a border on the
          // container: that is what lets the line stop at each icon instead of
          // running through it, while still spanning any expanded content.
          <div key={tc.toolCallId} className="flex gap-2">
            <div className="flex shrink-0 flex-col items-center">
              {/* mt-[3px] centres a 14px icon on the 20px title row beside it. */}
              <Icon className={cn("mt-[3px] size-3.5 shrink-0", statusIcon(tc))} />
              {!isLast && <span className="mt-1 w-px flex-1 bg-border" />}
            </div>
            <div className={cn("min-w-0 flex-1", !isLast && "pb-1.5")}>
              <button
                type="button"
                disabled={!hasContent}
                aria-expanded={hasContent ? isExpanded : undefined}
                onClick={() => hasContent && toggleExpand(tc.toolCallId)}
                className={cn(
                  "flex max-w-full gap-2 rounded-md px-1 py-0.5 text-left text-xs",
                  showCommand ? "w-full items-start" : "w-fit items-center",
                  hasContent ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
                )}
              >
                {showCommand ? (
                  <CommandLabel command={tc.title} />
                ) : (
                  <ToolCallTitle
                    title={tc.title}
                    className={cn(
                      "truncate",
                      running
                        ? "shimmer-text"
                        : tc.status === "error"
                          ? "text-destructive"
                          : "text-foreground/80",
                    )}
                  />
                )}
                {tc.status === "error" && (
                  <span className="shrink-0 text-[10px] text-destructive">Failed</span>
                )}
                {tc.status === "interrupted" && (
                  <span className="shrink-0 text-[10px] text-warning/70">Interrupted</span>
                )}
              </button>
              {isExpanded && (
                <ContentErrorBoundary>
                  {/* The command itself is the label above — only output goes here. */}
                  <div className="space-y-1.5 pt-1 pb-1.5 pl-1">
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
          </div>
        );
      })}
    </div>
  );
}
