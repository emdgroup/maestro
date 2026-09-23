import { CornerDownRight, FolderGit2, MessageCircleQuestion, Trash2 } from "lucide-react";
import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils";
import { folderName } from "@/components/execution/worktree-card/worktree-usage";
import { keptWorkspace, runDuration, waitDuration, type RunEntry, type RunState } from "./runs";

const DOT: Record<RunState, string> = {
  running: "bg-emerald-500 animate-pulse",
  awaiting: "bg-amber-500 animate-pulse",
  succeeded: "bg-emerald-500",
  failed: "bg-destructive",
};

function startedAt(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * One firing of an automation.
 *
 * Running and awaiting are the same row to the database, so the colour and the word are the only
 * thing that separates a run getting on with it from one that has been waiting on an answer since
 * three in the morning. The button says `Answer` for the second, because that is what it leads to.
 *
 * Nothing happens on clicking the card itself: the action is a button, and a card that also acted
 * would make the button decorative and every stray click consequential.
 */
export function RunCard({
  entry,
  /** Shown in the panel, where the row alone does not say which automation this was. */
  withName,
  now,
  onOpen,
  pending,
  onDelete,
}: {
  entry: RunEntry;
  withName: boolean;
  now: number;
  onOpen: () => void;
  /** True while a closed session is being loaded again. */
  pending: boolean;
  /** Forget this run, and remove its worktree and branch if they are still there. */
  onDelete: () => void;
}) {
  const { run, state, action } = entry;
  const awaiting = state === "awaiting";
  const kept = keptWorkspace(run);

  return (
    <div
      className={cn(
        "group/run rounded-md border px-2 py-1.5",
        awaiting ? "border-amber-500/40 bg-amber-500/5" : "border-border bg-background",
        state === "failed" && "border-destructive/30 bg-destructive/5",
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className={cn("size-1.5 shrink-0 rounded-full", DOT[state])} />
        {withName && <span className="truncate font-medium">{run.automation_name}</span>}
        <span className={cn("text-muted-foreground", !withName && "font-medium text-foreground")}>
          {startedAt(run.started_at)}
        </span>
        {run.ordinal != null && (
          <span className="shrink-0 font-mono text-muted-foreground/60">#{run.ordinal}</span>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {run.scheduled ? "scheduled" : "run now"}
        </span>
        {/* Not offered while the run is going: its agent is working in that worktree. */}
        {run.status !== "running" && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onDelete}
                  aria-label="Delete this run"
                  className="size-4 shrink-0 text-muted-foreground opacity-0 group-hover/run:opacity-100 hover:text-destructive focus-visible:opacity-100"
                />
              }
            >
              <Trash2 className="size-2.5" />
            </TooltipTrigger>
            <TooltipContent>
              {run.worktree_path
                ? "Delete this run, its worktree and its branch"
                : "Delete this run"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="mt-1 flex items-center gap-1.5 text-[10px]">
        {awaiting ? (
          <span className="flex items-center gap-1 text-amber-600">
            <MessageCircleQuestion className="size-3" />
            waiting on you for {waitDuration(entry, now)}
          </span>
        ) : state === "failed" && run.error ? (
          <span className="truncate text-destructive">{run.error}</span>
        ) : (
          <span className="text-muted-foreground">
            {state === "running" ? `running for ${runDuration(run, now)}` : runDuration(run, now)}
          </span>
        )}

        {action !== "none" && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={pending}
                  onClick={onOpen}
                  className={cn(
                    "ml-auto h-5 shrink-0 gap-1 border px-1.5 text-[10px]",
                    awaiting
                      ? "border-amber-500 text-amber-600 hover:bg-amber-500/10 hover:text-amber-600"
                      : "border-accent text-accent hover:bg-accent/10 hover:text-accent",
                  )}
                />
              }
            >
              <CornerDownRight className="size-2.5" />
              {pending ? "Opening" : awaiting ? "Answer" : "Go to session"}
            </TooltipTrigger>
            <TooltipContent>
              {action === "open"
                ? "Open the session this run is in"
                : "Load this run's transcript back into a session"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Only a run that kept its workspace says anything here. One that was cleaned up left
          nothing to act on, and saying so on every card would bury the ones that did. */}
      {kept && (
        <div className="mt-1 flex items-start gap-1 text-[10px] leading-relaxed text-warning">
          <FolderGit2 className="mt-px size-3 shrink-0" />
          <span className="min-w-0">
            Kept <span className="font-mono">{folderName(kept.path)}</span>: {kept.reason}
          </span>
        </div>
      )}
    </div>
  );
}
