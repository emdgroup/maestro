import {
  CalendarClock,
  CornerDownRight,
  FolderGit2,
  MessageCircleQuestion,
  Play,
  Trash2,
} from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils";
import { relativeAge } from "@/components/execution/worktree-card/worktree-usage";
import { keptWorkspace, runDuration, waitDuration, type RunEntry } from "./runs";

function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** How the run was started, as an icon: in the spot where the time goes, words read as a time. */
export function TriggerIcon({ scheduled }: { scheduled: boolean }) {
  return (
    <Hint label={scheduled ? "Started by its schedule" : "Started with Run now"}>
      {scheduled ? <CalendarClock className="size-3" /> : <Play className="size-3" />}
    </Hint>
  );
}

function StartedAgo({ iso, now }: { iso: string; now: number }) {
  return (
    <Hint label={new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}>
      {relativeAge(iso, now)} ago
    </Hint>
  );
}

/** What happened, in one line: the wait, the time it took, or why it failed. */
function Outcome({ entry, now }: { entry: RunEntry; now: number }) {
  const { run, state } = entry;
  if (state === "awaiting") {
    return (
      <span className="min-w-0 flex-1 truncate text-amber-600">
        waiting on you for {waitDuration(entry, now)}
      </span>
    );
  }
  if (state === "running") {
    return (
      <span className="min-w-0 flex-1 truncate text-emerald-600">
        {entry.live ? `running for ${runDuration(run, now)}` : "starting"}
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="min-w-0 flex-1 truncate text-destructive">{run.error ?? "Failed"}</span>
    );
  }
  return (
    <span className="min-w-0 flex-1 truncate text-muted-foreground">
      took {runDuration(run, now)}
    </span>
  );
}

/**
 * One firing of an automation.
 *
 * A finished run is read, not joined: clicking it opens its result, and the session is one more
 * click away in there. A run still going is the opposite, since what it needs is somebody in the
 * session, so its card carries Join, or Answer when it is blocked on a question.
 *
 * `row` is the automation's own list, where the name is already known and there is width to lay
 * the details out as columns. `card` is Recent runs, narrow, where the name is the headline.
 */
export function RunCard({
  entry,
  layout,
  now,
  onJoin,
  onShow,
  onDelete,
}: {
  entry: RunEntry;
  layout: "row" | "card";
  now: number;
  /** Go into the live session this run is happening in. */
  onJoin: () => void;
  /** Open the finished run's result. */
  onShow: () => void;
  /** Forget this run, and remove its worktree and branch if they are still there. */
  onDelete: () => void;
}) {
  const { run, state } = entry;
  const live = state === "running" || state === "awaiting";
  const kept = keptWorkspace(run);

  const action = live ? (
    entry.live && (
      <Button
        variant="ghost"
        size="xs"
        onClick={onJoin}
        className={cn(
          "h-5 shrink-0 gap-1 border px-1.5 text-[10px]",
          state === "awaiting"
            ? "border-amber-500 text-amber-600 hover:bg-amber-500/10 hover:text-amber-600"
            : "border-accent text-accent hover:bg-accent/10 hover:text-accent",
        )}
      >
        {state === "awaiting" ? (
          <MessageCircleQuestion className="size-2.5" />
        ) : (
          <CornerDownRight className="size-2.5" />
        )}
        {state === "awaiting" ? "Answer" : "Join"}
      </Button>
    )
  ) : (
    <>
      {kept && (
        <Hint label="This run's workspace was kept. Open the run for details.">
          <FolderGit2 className="size-3 text-warning" />
        </Hint>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                onDelete();
              }}
              aria-label="Delete this run"
              className="size-4 shrink-0 text-muted-foreground hover:text-destructive"
            />
          }
        >
          <Trash2 className="size-2.5" />
        </TooltipTrigger>
        <TooltipContent>
          {run.worktree_path ? "Delete this run, its worktree and its branch" : "Delete this run"}
        </TooltipContent>
      </Tooltip>
    </>
  );

  // Only a finished run opens anything; a live one's way in is its button.
  const showable = !live;
  const interactive = showable
    ? {
        role: "button" as const,
        tabIndex: 0,
        onClick: onShow,
        onKeyDown: (event: KeyboardEvent) => {
          if (
            event.target === event.currentTarget &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            onShow();
          }
        },
      }
    : {};

  if (layout === "row") {
    return (
      <div
        {...interactive}
        className={cn(
          "flex h-7 items-center gap-2 px-2 text-[11px]",
          state === "awaiting" && "bg-amber-500/5",
          state === "failed" && "bg-destructive/5",
          showable && "cursor-pointer hover:bg-muted/60",
        )}
      >
        <span className="w-8 shrink-0 font-mono text-muted-foreground/70">
          {run.ordinal != null ? `#${run.ordinal}` : ""}
        </span>
        <span className="w-16 shrink-0 text-muted-foreground">
          <StartedAgo iso={run.started_at} now={now} />
        </span>
        <span className="text-muted-foreground">
          <TriggerIcon scheduled={run.scheduled} />
        </span>
        <Outcome entry={entry} now={now} />
        {action}
      </div>
    );
  }

  return (
    <div
      {...interactive}
      className={cn(
        "rounded-md border px-2 py-1.5",
        state === "awaiting"
          ? "border-amber-500/40 bg-amber-500/5"
          : state === "failed"
            ? "border-destructive/30 bg-destructive/5"
            : "border-border bg-background",
        showable && "cursor-pointer hover:bg-muted/60",
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="min-w-0 flex-1 truncate font-medium">{run.automation_name}</span>
        {run.ordinal != null && (
          <span className="shrink-0 font-mono text-muted-foreground/60">#{run.ordinal}</span>
        )}
      </div>
      <div className="mt-0.5 flex min-h-5 items-center gap-1.5 text-[10px]">
        <span className="text-muted-foreground">
          <TriggerIcon scheduled={run.scheduled} />
        </span>
        {!live && (
          <span className="shrink-0 text-muted-foreground">
            <StartedAgo iso={run.started_at} now={now} />
          </span>
        )}
        <Outcome entry={entry} now={now} />
        {action}
      </div>
    </div>
  );
}
