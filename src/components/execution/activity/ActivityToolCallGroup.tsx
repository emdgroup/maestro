import { useContext, useState } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { CommandLabel } from "./CommandLabel";
import { OpenFileContext } from "./MarkdownBlock";
import {
  FileLabel,
  hasRowContent,
  isRunning,
  labelBecomesCommand,
  rowIcon,
  rowKeyDown,
  rowLabel,
  RowMeta,
  StatusWord,
  titleSuffix,
  ToolCallTimeline,
  ToolCallTitle,
} from "./ToolCallTimeline";
import type { ToolCallItem } from "./types";

const KIND_LABEL: Record<string, string> = {
  read: "files read",
  read_file: "files read",
  edit: "files edited",
  write_file: "files edited",
  edit_file: "files edited",
  create_file: "files edited",
  delete: "files deleted",
  move: "files moved",
  search: "file searches",
  execute: "commands executed",
  bash: "commands executed",
  shell: "commands executed",
  run_terminal: "commands executed",
  fetch: "URLs fetched",
  switch_mode: "mode switches",
};

/**
 * Short past-tense nouns, used only when a run mixes tools that share one `kind`
 * — "2 edited · 1 created" instead of the "3 files edited" that kind alone can say.
 */
const TOOL_NOUN: Record<string, string> = {
  Read: "read",
  Write: "created",
  Edit: "edited",
  NotebookEdit: "edited",
  Bash: "commands",
  Grep: "searches",
  Glob: "searches",
  Task: "agents",
  Agent: "agents",
  WebFetch: "fetched",
  WebSearch: "searches",
};

function kindGroupLabel(kind: string, count: number): string {
  const label = KIND_LABEL[kind] ?? "tool calls";
  return `${count} ${label}`;
}

/**
 * Falls back to the kind summary unless every call names a tool we have a noun
 * for *and* those nouns differ — one tool repeated reads better as its kind label.
 */
function toolGroupLabel(items: ToolCallItem[]): string | null {
  const nouns = items.map((i) => TOOL_NOUN[i.meta?.toolName ?? ""]);
  if (nouns.some((n) => !n)) return null;
  const counts = new Map<string, number>();
  for (const noun of nouns) counts.set(noun, (counts.get(noun) ?? 0) + 1);
  if (counts.size < 2) return null;
  return [...counts].map(([noun, n]) => `${n} ${noun}`).join(" · ");
}

interface ActivityToolCallGroupProps {
  items: ToolCallItem[];
}

/**
 * One muted line per run of tool calls. While running and closed it names the
 * call in flight; open, or once settled, it falls back to a summary — so the
 * line and the timeline never animate the same thing at once.
 *
 * Nothing here opens or closes on its own: a group the user expanded must stay
 * expanded as later calls stream in.
 */
export function ActivityToolCallGroup({ items }: ActivityToolCallGroupProps) {
  const [open, setOpen] = useState(false);
  const openFile = useContext(OpenFileContext);

  // `pending` counts as running: a new call lands pending before it starts, and
  // ignoring that flickers the line back to the summary between calls.
  const current = [...items].reverse().find(isRunning);
  const showCurrent = current != null && !open;

  const errorCount = items.filter((i) => i.status === "error").length;
  const isSingle = items.length === 1;
  const fileItem = isSingle && items[0].meta?.filePath ? items[0] : null;
  // Aliases like execute/bash/shell share a label — treat them as the same category.
  const allSameKind =
    items.length > 0 &&
    items.every(
      (i) => (KIND_LABEL[i.kind] ?? i.kind) === (KIND_LABEL[items[0].kind] ?? items[0].kind),
    );

  // Only a real tool call title gets its action word bolded — the count summary
  // has no action, and bolding its digit would just be noise.
  const title = showCurrent ? rowLabel(current) : isSingle ? rowLabel(items[0]) : null;

  const Icon = showCurrent ? rowIcon(current) : allSameKind ? rowIcon(items[0]) : Wrench;

  // A group with nothing to open (a bare switch_mode, say) stays plain text.
  // Multiple items are always expandable so users can see which files were read.
  const expandable = items.length > 1 || items.some(hasRowContent);

  const labelClass = cn(
    "min-w-0 truncate",
    showCurrent ? "shimmer-text" : isSingle && errorCount > 0 && "text-destructive",
  );

  // Open on a lone command with no description of its own, the header line is the
  // only place the command is shown — so it renders in full.
  const showCommand = open && isSingle && labelBecomesCommand(items[0]);

  const line = (
    <>
      <Icon className={cn("size-3.5 shrink-0", showCommand && "mt-0.5")} />
      {showCommand ? (
        <CommandLabel command={items[0].title} />
      ) : title != null ? (
        <ToolCallTitle title={title} className={labelClass} />
      ) : (
        <span className={labelClass}>
          {toolGroupLabel(items) ??
            (allSameKind
              ? kindGroupLabel(items[0].kind, items.length)
              : `${items.length} tool calls`)}
        </span>
      )}
      {/* Only alongside the summary. While the line names the call in flight it
          is about that call, and a count of earlier failures reads as its own. */}
      {title == null && errorCount > 0 && (
        <span className="shrink-0 text-[10px] text-destructive">· {errorCount} failed</span>
      )}
    </>
  );

  // A lone file call puts its name on this line, and the name is a control of its
  // own — clicking it opens the file rather than the group.
  const fileLine = fileItem && openFile && (
    <>
      <Icon className={cn("size-3.5 shrink-0", showCurrent && "text-accent")} />
      <FileLabel
        tc={fileItem}
        expanded={open}
        onOpenFile={openFile}
        className={cn(showCurrent && "shimmer-text")}
      />
      <StatusWord tc={fileItem} />
    </>
  );

  // A lone call has no timeline row of its own, so its detail belongs on this line.
  const detail =
    isSingle && !showCurrent ? (
      <RowMeta tc={items[0]} prefix={fileLine ? titleSuffix(items[0]) : null} />
    ) : null;

  return (
    <div>
      <div className={cn("flex max-w-full", showCommand ? "items-start" : "items-center")}>
        {/* Same shape as a timeline row: the label and its chevron are the
            toggle, the detail sits on the right edge. */}
        <div
          role={expandable ? "button" : undefined}
          tabIndex={expandable ? 0 : undefined}
          aria-expanded={expandable ? open : undefined}
          onClick={expandable ? () => setOpen((v) => !v) : undefined}
          onKeyDown={expandable ? rowKeyDown(() => setOpen((v) => !v)) : undefined}
          className={cn(
            "-ml-1 flex min-w-0 gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground",
            showCommand ? "flex-1 items-start" : "items-center",
            expandable &&
              "cursor-pointer transition-colors hover:bg-muted/40 hover:text-foreground/75",
          )}
        >
          {fileLine || line}
          {expandable &&
            (open ? (
              <ChevronDown className={cn("size-3 shrink-0", showCommand && "mt-1")} />
            ) : (
              <ChevronRight className="size-3 shrink-0" />
            ))}
        </div>
        {detail}
      </div>
      {open && (
        <div className="mt-1 ml-1.5">
          <ToolCallTimeline items={items} inline={isSingle} />
        </div>
      )}
    </div>
  );
}
