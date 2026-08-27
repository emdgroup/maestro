import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { TriangleAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { Checkbox } from "@/ui/checkbox";
import { ScrollArea } from "@/ui/scroll-area";
import { Spinner } from "@/ui/spinner";
import { cn } from "@/lib/utils";
import { parseDiffStat } from "@/lib/diff-utils";
import { usePruneBranchesMutation } from "@/services/worktree.service";
import type { PrunableBranch } from "@/types/bindings";

interface PruneBranchesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: number;
  branches: PrunableBranch[];
}

function relativeTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : formatDistanceToNow(date, { addSuffix: true });
}

function GroupHeader({ label, count, note }: { label: string; count: number; note: string }) {
  return (
    <div className="flex items-baseline gap-2 mb-1.5">
      <span
        className={cn(
          "text-[10px] font-semibold uppercase tracking-wider",
          label === "Unmerged" ? "text-warning" : "text-muted-foreground",
        )}
      >
        {label} · {count}
      </span>
      <span className="text-[11px] text-muted-foreground">{note}</span>
    </div>
  );
}

/**
 * Confirmation for deleting `maestro/` branches that no worktree and no remote is holding —
 * both session branches and task branches, which share the namespace.
 *
 * Merged branches arrive preselected because deleting one loses nothing. An unmerged branch
 * has to be ticked by hand, and that tick is the whole opt-in to `git branch -D` — a second
 * confirm checkbox over the same decision would only be a click tax, so the footer carries the
 * warning instead.
 *
 * Selection is seeded once per mount; callers pass a `key` so reopening starts fresh.
 */
export function PruneBranchesDialog({
  open,
  onOpenChange,
  projectId,
  branches,
}: PruneBranchesDialogProps) {
  const merged = branches.filter((branch) => branch.merged);
  const unmerged = branches.filter((branch) => !branch.merged);

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(merged.map((branch) => branch.name)),
  );
  const pruneMutation = usePruneBranchesMutation();

  const selectedUnmerged = unmerged.filter((branch) => selected.has(branch.name));
  const force = selectedUnmerged.length > 0;
  const lostCommits = selectedUnmerged.reduce((total, branch) => total + branch.commits, 0);

  const toggle = (name: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const renderRow = (branch: PrunableBranch) => {
    const stat = parseDiffStat(branch.diff_stat);
    return (
      <div
        key={branch.name}
        className="flex items-center gap-3 px-3 py-2 border-b border-border last:border-b-0 cursor-pointer hover:bg-muted/30"
        onClick={() => toggle(branch.name)}
      >
        <Checkbox
          aria-label={branch.name}
          checked={selected.has(branch.name)}
          onCheckedChange={() => toggle(branch.name)}
          // Without this the row's own handler fires too and the tick immediately undoes itself.
          onClick={(e) => e.stopPropagation()}
        />
        <span className="font-mono text-xs flex-1 truncate">{branch.name}</span>
        {!branch.merged && (
          <span className="flex items-center gap-2 font-mono text-[11px]">
            {branch.commits > 0 && (
              <span className="text-muted-foreground">
                {branch.commits} {branch.commits === 1 ? "commit" : "commits"}
              </span>
            )}
            {stat && stat.insertions > 0 && (
              <span className="text-success">+{stat.insertions}</span>
            )}
            {stat && stat.deletions > 0 && (
              <span className="text-destructive">-{stat.deletions}</span>
            )}
          </span>
        )}
        <span className="text-[11px] text-muted-foreground whitespace-nowrap">
          {relativeTime(branch.last_commit_at)}
        </span>
      </div>
    );
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!pruneMutation.isPending) onOpenChange(next);
      }}
    >
      <AlertDialogContent className="sm:max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Prune stale branches?</AlertDialogTitle>
          <AlertDialogDescription>
            {branches.length} maestro/ {branches.length === 1 ? "branch has" : "branches have"} no
            worktree and no branch on origin. Pruning does not affect any worktree.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <ScrollArea className="max-h-72">
          {merged.length > 0 && (
            <>
              <GroupHeader label="Merged into HEAD" count={merged.length} note="nothing is lost" />
              <div className="rounded-lg border border-border overflow-hidden">
                {merged.map(renderRow)}
              </div>
            </>
          )}
          {unmerged.length > 0 && (
            <div className={cn(merged.length > 0 && "mt-4")}>
              <GroupHeader
                label="Unmerged"
                count={unmerged.length}
                note="these commits exist nowhere else"
              />
              <div className="rounded-lg border border-warning/40 overflow-hidden">
                {unmerged.map(renderRow)}
              </div>
            </div>
          )}
        </ScrollArea>

        {force && (
          <div className="flex gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs leading-relaxed">
            <TriangleAlert className="size-4 shrink-0 text-warning mt-px" />
            <span>
              {selectedUnmerged.length} unmerged{" "}
              {selectedUnmerged.length === 1 ? "branch" : "branches"} will be deleted with{" "}
              <span className="font-mono">git branch -D</span>. {lostCommits}{" "}
              {lostCommits === 1 ? "commit exists" : "commits exist"} on no other branch and cannot
              be recovered.
            </span>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pruneMutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={force ? "destructive" : "default"}
            disabled={selected.size === 0 || pruneMutation.isPending}
            onClick={() => {
              pruneMutation.mutate(
                { projectId, branches: [...selected], force },
                { onSuccess: () => onOpenChange(false) },
              );
            }}
          >
            {pruneMutation.isPending ? (
              <>
                <Spinner className="size-3.5" />
                Pruning...
              </>
            ) : (
              `Prune ${selected.size} ${selected.size === 1 ? "branch" : "branches"}`
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
