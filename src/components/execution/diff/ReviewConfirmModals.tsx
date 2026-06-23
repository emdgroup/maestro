import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/ui/alert-dialog";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/ui/dropdown-menu";
import type { PendingComment } from "./DiffViewer";

// --- ReworkModal ---
interface ReworkModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  comments: PendingComment[];
  onConfirm: (data: { comments: PendingComment[]; generalFeedback: string }) => void;
  isPending?: boolean;
}

export function ReworkModal({
  open,
  onOpenChange,
  comments,
  onConfirm,
  isPending,
}: ReworkModalProps) {
  const [expanded, setExpanded] = useState(true);
  const [feedback, setFeedback] = useState("");

  function handleSubmit() {
    onConfirm({ comments, generalFeedback: feedback });
    setFeedback("");
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Request changes</AlertDialogTitle>
          <AlertDialogDescription>
            Submit {comments.length} comment{comments.length !== 1 ? "s" : ""} and send task back
            for rework.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {comments.length > 0 && (
          <div className="border rounded-md">
            <Button
              variant="ghost"
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-2 w-full px-3 py-2 h-auto text-xs font-medium hover:bg-accent rounded-t-md justify-start"
            >
              {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              {comments.length} comment{comments.length !== 1 ? "s" : ""}
            </Button>
            {expanded && (
              <div className="max-h-40 overflow-y-auto custom-scrollbar border-t divide-y">
                {comments.map((c) => (
                  <div key={c.id} className="px-3 py-2 text-xs">
                    <span className="font-mono text-muted-foreground">
                      {c.filePath}
                      {c.lineNumber > 0 ? `:${c.lineNumber}` : ""}
                    </span>
                    <div className="mt-0.5 text-foreground">
                      <MarkdownBlock text={c.text} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Additional feedback (optional)..."
          className="w-full min-h-[60px] resize-y rounded-md border bg-transparent px-3 py-2 text-sm outline-none"
          rows={3}
        />

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button
            onClick={handleSubmit}
            disabled={isPending}
            className="bg-amber-600 hover:bg-amber-700 text-white"
          >
            {isPending ? "Submitting..." : "Submit review"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// --- ApproveModal ---
interface ApproveModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasWorktree: boolean;
  hasUncommitted: boolean;
  untrackedCount: number;
  commitMessage: string;
  onConfirm: (data: {
    mergeStrategy: string;
    includeUntracked: boolean;
    commitMessage: string;
  }) => void;
  isPending?: boolean;
}

export function ApproveModal({
  open,
  onOpenChange,
  hasWorktree,
  hasUncommitted,
  untrackedCount,
  commitMessage: initialCommitMessage,
  onConfirm,
  isPending,
}: ApproveModalProps) {
  const [strategy, setStrategy] = useState("merge-delete");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [commitMessage, setCommitMessage] = useState(initialCommitMessage);

  useEffect(() => {
    setCommitMessage(initialCommitMessage);
  }, [initialCommitMessage]);

  const showRadio = hasWorktree && hasUncommitted;

  function getDescription(): string {
    if (hasWorktree && !hasUncommitted)
      return "Changes are committed. This will merge the branch and delete the worktree.";
    if (!hasWorktree && hasUncommitted)
      return "Uncommitted changes will be committed and the task marked as done.";
    if (!hasWorktree && !hasUncommitted)
      return "All changes are committed. Task will be marked as done.";
    return "Choose how to handle the worktree:";
  }

  function getActionLabel(): string {
    if (hasWorktree && !hasUncommitted) return "Approve & Merge";
    if (!hasWorktree && hasUncommitted) return "Approve & Commit";
    return "Approve";
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Approve task</AlertDialogTitle>
          <AlertDialogDescription>{getDescription()}</AlertDialogDescription>
        </AlertDialogHeader>

        {showRadio && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="strategy"
                value="merge-delete"
                checked={strategy === "merge-delete"}
                onChange={() => setStrategy("merge-delete")}
              />
              Commit + Merge + Delete worktree
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="strategy"
                value="commit-only"
                checked={strategy === "commit-only"}
                onChange={() => setStrategy("commit-only")}
              />
              Commit only (keep worktree)
            </label>
          </div>
        )}

        {untrackedCount > 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={includeUntracked}
                onChange={(e) => setIncludeUntracked(e.target.checked)}
              />
              Include {untrackedCount} untracked file{untrackedCount !== 1 ? "s" : ""} (not yet
              committed)
            </label>
            {!includeUntracked && (
              <p className="text-xs text-destructive">
                These files will be permanently lost when the worktree is deleted.
              </p>
            )}
          </div>
        )}

        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Commit message</p>
          <textarea
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            className="w-full min-h-[80px] resize-y rounded-md border bg-transparent px-3 py-2 text-sm font-mono outline-none"
            rows={4}
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button
            onClick={() => onConfirm({ mergeStrategy: strategy, includeUntracked, commitMessage })}
            disabled={isPending || !commitMessage.trim()}
          >
            {isPending ? "Approving..." : showRadio ? "Confirm" : getActionLabel()}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// --- DiscardModal ---
interface DiscardModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  worktreePath: string | null;
  branchName: string | null;
  commitCount: number;
  onConfirm: (action: "backlog" | "cancel") => void;
  isPending?: boolean;
}

export function DiscardModal({
  open,
  onOpenChange,
  worktreePath,
  branchName,
  commitCount,
  onConfirm,
  isPending,
}: DiscardModalProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-destructive" />
            Discard review
          </AlertDialogTitle>
          <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm space-y-1">
          {worktreePath && (
            <p>
              Worktree <code className="text-xs bg-muted px-1 rounded">{worktreePath}</code> will be
              deleted
            </p>
          )}
          {branchName && (
            <p>
              Branch <code className="text-xs bg-muted px-1 rounded">{branchName}</code> will be
              removed
            </p>
          )}
          {commitCount > 0 && (
            <p>
              {commitCount} commit{commitCount !== 1 ? "s" : ""} will be rolled back
            </p>
          )}
          {!worktreePath && commitCount === 0 && <p>Task will be moved without code changes.</p>}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <ButtonGroup>
            <Button size="sm" onClick={() => onConfirm("backlog")} disabled={isPending}>
              {isPending ? "Discarding..." : "Send to Backlog"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="sm" className="px-1.5!" disabled={isPending}>
                    <ChevronDown className="size-3.5" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem variant="destructive" onClick={() => onConfirm("cancel")}>
                  Cancel task
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
