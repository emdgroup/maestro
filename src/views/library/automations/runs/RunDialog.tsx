import { CornerDownRight, FolderGit2, Trash2 } from "lucide-react";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { cn } from "@/lib/utils";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { folderName, relativeAge } from "@/components/execution/worktree-card/worktree-usage";
import { keptWorkspace, runDuration, type RunEntry } from "./runs";

/**
 * A finished run, read without going into its session.
 *
 * What a scheduled run is for is its result, so that is the body: the agent's last message for a
 * run that succeeded, the reason for one that failed. Everything the card had no room for sits
 * around it, and the session is here rather than on the card because most runs never need it.
 */
export function RunDialog({
  entry,
  agentName,
  now,
  opening,
  onOpenChange,
  onOpenSession,
  onDelete,
}: {
  /** The run to show, or `null` when the dialog is closed. */
  entry: RunEntry | null;
  agentName: (agentId: string) => string;
  now: number;
  /** True while a closed session is being loaded back. */
  opening: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSession: (entry: RunEntry) => void;
  onDelete: (entry: RunEntry) => void;
}) {
  const run = entry?.run;
  const kept = run ? keptWorkspace(run) : null;
  const failed = entry?.state === "failed";

  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      {entry && run && (
        <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="truncate">{run.automation_name}</span>
              {run.ordinal != null && (
                <span className="font-mono text-xs font-normal text-muted-foreground">
                  #{run.ordinal}
                </span>
              )}
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] font-normal",
                  failed
                    ? "bg-destructive/15 text-destructive"
                    : "bg-emerald-500/15 text-emerald-600",
                )}
              >
                {failed ? "Failed" : "Succeeded"}
              </span>
            </DialogTitle>
            <DialogDescription className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
              <span>
                {new Date(run.started_at).toLocaleString([], {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
                , {relativeAge(run.started_at, now)} ago
              </span>
              <span>took {runDuration(run, now)}</span>
              <span>{run.scheduled ? "Started by its schedule" : "Started with Run now"}</span>
              {run.agent_id && <span>{agentName(run.agent_id)}</span>}
              {run.cwd && <span>in {folderName(run.cwd)}</span>}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            {failed ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {run.error ?? "The run failed without saying why."}
              </div>
            ) : run.result ? (
              <MarkdownBlock text={run.result} />
            ) : (
              <p className="text-sm text-muted-foreground">
                This run left no message. Open its session to see what it did.
              </p>
            )}

            {kept && (
              <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
                <div className="flex items-center gap-1 font-medium text-warning">
                  <FolderGit2 className="size-3" />
                  Workspace kept
                </div>
                <div className="mt-1 font-mono text-muted-foreground">{kept.path}</div>
                {run.worktree_branch && (
                  <div className="mt-0.5 font-mono text-muted-foreground">
                    {run.worktree_branch}
                  </div>
                )}
                <div className="mt-1 text-muted-foreground">{kept.reason}</div>
                <div className="mt-1 text-muted-foreground">
                  Deleting the run removes the worktree and the branch.
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="sm:justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDelete(entry)}
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
              Delete run
            </Button>
            {entry.action !== "none" && (
              <Button
                variant="outline"
                size="sm"
                disabled={opening}
                onClick={() => onOpenSession(entry)}
              >
                <CornerDownRight className="size-3.5" />
                {opening ? "Opening" : "Open session"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
