import { useState } from "react";
import { Box, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import {
  hasRowContent,
  isRunning,
  KIND_ICON,
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

function kindGroupLabel(kind: string, count: number): string {
  const label = KIND_LABEL[kind] ?? "tool calls";
  return `${count} ${label}`;
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

  // `pending` counts as running: a new call lands pending before it starts, and
  // ignoring that flickers the line back to the summary between calls.
  const current = [...items].reverse().find(isRunning);
  const showCurrent = current != null && !open;

  const errorCount = items.filter((i) => i.status === "error").length;
  const isSingle = items.length === 1;
  // Aliases like execute/bash/shell share a label — treat them as the same category.
  const allSameKind =
    items.length > 0 &&
    items.every(
      (i) => (KIND_LABEL[i.kind] ?? i.kind) === (KIND_LABEL[items[0].kind] ?? items[0].kind),
    );

  // Only a real tool call title gets its action word bolded — the count summary
  // has no action, and bolding its digit would just be noise.
  const title = showCurrent ? current.title : isSingle ? items[0].title : null;

  const Icon = showCurrent
    ? (KIND_ICON[current.kind] ?? Box)
    : allSameKind
      ? (KIND_ICON[items[0]?.kind] ?? Box)
      : Wrench;

  // A group with nothing to open (a bare switch_mode, say) stays plain text.
  // Multiple items are always expandable so users can see which files were read.
  const expandable = items.length > 1 || items.some(hasRowContent);

  const labelClass = cn(
    "truncate",
    showCurrent ? "shimmer-text" : isSingle && errorCount > 0 && "text-destructive",
  );

  const line = (
    <>
      <Icon className="size-3.5 shrink-0" />
      {title != null ? (
        <ToolCallTitle title={title} className={labelClass} />
      ) : (
        <span className={labelClass}>
          {allSameKind ? kindGroupLabel(items[0].kind, items.length) : `${items.length} tool calls`}
        </span>
      )}
      {!isSingle && errorCount > 0 && (
        <span className="shrink-0 text-[10px] text-destructive">· {errorCount} failed</span>
      )}
    </>
  );

  if (!expandable) {
    return (
      <div className="flex w-fit max-w-full items-center gap-1.5 py-0.5 text-xs text-muted-foreground">
        {line}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="-ml-1 flex w-fit max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground/75"
      >
        {line}
        {open ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
      </button>
      {open && (
        <div className="mt-1 ml-1.5">
          <ToolCallTimeline items={items} inline={isSingle} />
        </div>
      )}
    </div>
  );
}
