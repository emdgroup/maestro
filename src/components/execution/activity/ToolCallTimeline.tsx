import { useState } from "react";
import {
  ArrowRightLeft,
  Bot,
  Box,
  Brain,
  FileText,
  FilePlus,
  GitBranch,
  Globe,
  Pencil,
  Plug,
  Search,
  Settings2,
  ShieldAlert,
  Terminal,
  Trash2,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
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

/**
 * Keyed by the agent's own tool name, which `kind` cannot express: a new file and
 * an in-place edit both arrive as `edit`, and every MCP tool as a bare kind with
 * no icon of its own.
 */
const TOOL_ICON: Record<string, React.ElementType> = {
  Read: FileText,
  Write: FilePlus,
  Edit: Pencil,
  NotebookEdit: Pencil,
  Bash: Terminal,
  Grep: Search,
  Glob: Search,
  Task: Bot,
  Agent: Bot,
  WebFetch: Globe,
  WebSearch: Globe,
};

export function isTerminalKind(kind: string) {
  return /run_terminal|bash|shell|execute/.test(kind);
}

export function rowIcon(tc: ToolCallItem): React.ElementType {
  const meta = tc.meta;
  if (meta?.blocked) return ShieldAlert;
  if (meta?.git) return GitBranch;
  if (meta?.toolName) {
    const byTool = TOOL_ICON[meta.toolName];
    if (byTool) return byTool;
    if (meta.toolName.startsWith("mcp__")) return Plug;
  }
  return KIND_ICON[tc.kind] ?? Box;
}

/**
 * Shell calls carry both a command and the reason it was run. Collapsed, the
 * reason is the more useful of the two — the command is still shown in full once
 * the row is open, so nothing is lost.
 */
export function rowLabel(tc: ToolCallItem): string {
  const description = tc.meta?.description;
  return isTerminalKind(tc.kind) && description ? description : tc.title;
}

/**
 * Whether an open row should swap its label for the syntax-coloured command.
 * Only when no description took that slot — with one, the command lives in the
 * card below instead, and the row never shows the same string twice.
 */
export function labelBecomesCommand(tc: ToolCallItem): boolean {
  return isTerminalKind(tc.kind) && Boolean(tc.title) && !tc.meta?.description;
}

/** A call refused by policy never ran — that is not the same as one that crashed. */
export function isBlocked(tc: ToolCallItem): boolean {
  return tc.status === "error" && tc.meta?.blocked === true;
}

export function isReadKind(kind: string): boolean {
  return kind === "read" || kind === "read_file";
}

/**
 * A row is worth opening when it has content to show, or failed and owes an
 * explanation. Reads used to be excluded outright; they carry the excerpt the
 * agent actually saw, and the row never opens on its own, so the dump is opt-in.
 */
export function hasRowContent(tc: ToolCallItem): boolean {
  if (tc.status === "error") return true;
  return tc.content.length > 0 || tc.meta?.output != null;
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

/**
 * The file's length, not the slice that was read: agents already put the range in
 * the title ("Read foo.ts (60 - 89)"), so repeating it here would say nothing new.
 */
function readRange(meta: NonNullable<ToolCallItem["meta"]>): string | null {
  return meta.fileTotalLines == null ? null : `${meta.fileTotalLines} lines`;
}

/**
 * The right-hand slot: what the call actually did, in the units of its own tool.
 * Rendered as a sibling of the row button rather than inside it, so the PR chip
 * can be its own control.
 */
export function RowMeta({ tc }: { tc: ToolCallItem }) {
  const meta = tc.meta;
  if (!meta) return null;

  const parts: React.ReactNode[] = [];

  if (meta.linesAdded || meta.linesRemoved) {
    parts.push(
      <span key="diff">
        <span className="text-success">+{meta.linesAdded ?? 0}</span>{" "}
        <span className="text-destructive">−{meta.linesRemoved ?? 0}</span>
      </span>,
    );
  } else {
    const range = readRange(meta);
    if (range) parts.push(<span key="range">{range}</span>);
    else if (meta.matchFileCount != null) {
      parts.push(
        <span key="matches">
          {meta.matchFileCount} {meta.matchFileCount === 1 ? "file" : "files"}
        </span>,
      );
    }
  }

  const git = meta.git;
  if (git?.commitSha) {
    parts.push(
      <span key="sha" className="rounded-full border border-border px-1.5 font-mono">
        {git.commitSha.slice(0, 8)}
      </span>,
    );
  }
  if (git?.branchAction && git.branchRef) {
    parts.push(
      <span key="branch">
        {git.branchAction} {git.branchRef}
      </span>,
    );
  }
  if (git?.prNumber != null) {
    const label = `#${git.prNumber}${git.prAction ? ` ${git.prAction}` : ""}`;
    const url = git.prUrl;
    parts.push(
      url ? (
        <button
          key="pr"
          type="button"
          onClick={() => void openUrl(url)}
          className="rounded-full border border-border px-1.5 text-success hover:bg-muted/40"
        >
          {label}
        </button>
      ) : (
        <span key="pr" className="rounded-full border border-border px-1.5">
          {label}
        </span>
      ),
    );
  }

  if (parts.length === 0) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-[10px] text-muted-foreground">
      {parts}
    </span>
  );
}

/**
 * A call's output belongs to what produced it, so the two share one bordered box
 * — and the box is what gives a long dump or a file excerpt an edge to scroll
 * inside.
 *
 * The header strip appears only when the row label is the *description*: with no
 * description the label is already the command, and repeating it here is the
 * duplication the last redesign removed.
 */
function OutputCard({ tc, children }: { tc: ToolCallItem; children: React.ReactNode }) {
  const failed = tc.status === "error";
  const showCommand = Boolean(tc.meta?.description) && Boolean(tc.title);
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border",
        failed ? "border-destructive/40" : "border-border",
      )}
    >
      {showCommand && (
        <div
          className={cn(
            "flex items-start gap-1.5 px-2 py-1",
            failed ? "bg-destructive/10" : "bg-muted/60",
          )}
        >
          <span className="shrink-0 font-mono text-[11px] leading-relaxed text-muted-foreground/60 select-none">
            $
          </span>
          <CommandLabel command={tc.title} />
        </div>
      )}
      <div className="px-2 py-1.5">{children}</div>
    </div>
  );
}

/**
 * What an expanded row shows. `content[]` when the agent sent any; otherwise the
 * unstructured `rawOutput` it sent instead, which is the only body ~14% of
 * completed calls ever carry.
 */
export function RowBody({ tc }: { tc: ToolCallItem }) {
  const meta = tc.meta;
  const blocked = isBlocked(tc);
  // A refusal repeats itself: a paragraph of boilerplate in content[] wrapping the
  // one sentence in `errorText`. Show the sentence.
  const reason = blocked ? meta?.errorText : undefined;

  const body = reason ? (
    <pre className="font-mono text-[11px] break-words whitespace-pre-wrap text-warning/80">
      {reason}
    </pre>
  ) : (
    <div className="space-y-1.5">
      {tc.content.map((c, i) => (
        <ToolCallContentBlock key={i} content={c} />
      ))}
      {tc.content.length === 0 && meta?.output && (
        <div className="custom-scrollbar max-h-64 overflow-y-auto">
          <pre
            className={cn(
              "font-mono text-[11px] break-words whitespace-pre-wrap",
              tc.status === "error" && "text-destructive",
            )}
          >
            {meta.output}
          </pre>
        </div>
      )}
      {tc.status === "error" && tc.content.length === 0 && !meta?.output && (
        <span className="text-xs text-destructive italic">
          {meta?.errorText ?? "Tool call failed"}
        </span>
      )}
    </div>
  );

  return (
    <ContentErrorBoundary>
      <div className="pt-1 pb-1.5 pl-1">
        {isTerminalKind(tc.kind) || isReadKind(tc.kind) ? (
          <OutputCard tc={tc}>{body}</OutputCard>
        ) : (
          body
        )}
      </div>
    </ContentErrorBoundary>
  );
}

/** The kind icon doubles as the rail's status marker, so it carries the colour. */
function statusIcon(tc: ToolCallItem): string {
  if (isRunning(tc)) return "text-secondary animate-pulse";
  if (isBlocked(tc)) return "text-warning/70";
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
    return <RowBody tc={items[0]} />;
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
        const Icon = rowIcon(tc);
        const hasContent = hasRowContent(tc);
        const isExpanded = expandedIds.has(tc.toolCallId);
        const running = isRunning(tc);
        const isLast = i === items.length - 1;
        // Expanded, the label stops being a truncated summary and becomes the
        // command in full — so the row never shows the same string twice.
        const showCommand = isExpanded && labelBecomesCommand(tc);

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
              <div className={cn("flex max-w-full", showCommand ? "items-start" : "items-center")}>
                <button
                  type="button"
                  disabled={!hasContent}
                  aria-expanded={hasContent ? isExpanded : undefined}
                  onClick={() => hasContent && toggleExpand(tc.toolCallId)}
                  className={cn(
                    "flex min-w-0 gap-2 rounded-md px-1 py-0.5 text-left text-xs",
                    showCommand ? "flex-1 items-start" : "items-center",
                    hasContent ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
                  )}
                >
                  {showCommand ? (
                    <CommandLabel command={tc.title} />
                  ) : (
                    <ToolCallTitle
                      title={rowLabel(tc)}
                      className={cn(
                        "truncate",
                        running
                          ? "shimmer-text"
                          : isBlocked(tc)
                            ? "text-warning/80"
                            : tc.status === "error"
                              ? "text-destructive"
                              : "text-foreground/80",
                      )}
                    />
                  )}
                  {tc.status === "error" && (
                    <span
                      className={cn(
                        "shrink-0 text-[10px]",
                        isBlocked(tc) ? "text-warning/70" : "text-destructive",
                      )}
                    >
                      {isBlocked(tc) ? "Blocked" : "Failed"}
                    </span>
                  )}
                  {tc.status === "interrupted" && (
                    <span className="shrink-0 text-[10px] text-warning/70">Interrupted</span>
                  )}
                </button>
                <RowMeta tc={tc} />
              </div>
              {isExpanded && <RowBody tc={tc} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
