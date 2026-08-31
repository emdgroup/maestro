import { useState } from "react";
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
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { Checkbox } from "@/ui/checkbox";
import type { LandingMode } from "@/types/bindings";
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
      <AlertDialogContent className="max-w-lg max-h-[90vh] overflow-hidden">
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
          className="w-full min-h-[60px] max-h-[40vh] resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none overflow-y-auto [field-sizing:content]"
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
  /** Name of the remote to push to, when the project has one. */
  pushRemote?: string | null;
  /** The forge behind the remote, whether or not anything has authenticated for it. */
  pullRequestProvider?: string | null;
  /** Set when that forge is known but no credential answered for it. */
  pullRequestNeedsConnecting?: boolean;
  /**
   * Whether Maestro can open a pull request on this forge at all — a different question from
   * whether it is connected. Required rather than optional so a new call site has to answer it;
   * defaulting it would quietly restore the offer-then-fail this prop exists to prevent.
   */
  forgeSupportsPullRequests: boolean;
  /**
   * The project's choice of how approved work leaves Review, which decides the option this
   * dialog opens on. A preference, not a constraint: every strategy the project can actually
   * perform stays on offer, and one it cannot falls back to merging.
   */
  landingMode?: LandingMode | null;
  onConfirm: (data: {
    mergeStrategy: string;
    includeUntracked: boolean;
    commitMessage: string;
  }) => void;
  isPending?: boolean;
}

/// The strategy each landing mode asks for. `Merge` is also the fallback, so it is the value any
/// unavailable preference resolves to.
const STRATEGY_FOR_LANDING_MODE: Record<LandingMode, string> = {
  Merge: "merge-delete",
  PullRequest: "pull-request",
  PushOnly: "commit-push",
};

export function ApproveModal({
  open,
  onOpenChange,
  hasWorktree,
  hasUncommitted,
  untrackedCount,
  commitMessage: initialCommitMessage,
  pushRemote,
  pullRequestProvider,
  pullRequestNeedsConnecting,
  forgeSupportsPullRequests,
  landingMode,
  onConfirm,
  isPending,
}: ApproveModalProps) {
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [commitMessage, setCommitMessage] = useState(initialCommitMessage);

  // Re-seed the editable message when the prop changes, adjusted during render rather
  // than from an effect so the modal never paints a frame with the previous message.
  const [prevInitialCommitMessage, setPrevInitialCommitMessage] = useState(initialCommitMessage);
  if (prevInitialCommitMessage !== initialCommitMessage) {
    setPrevInitialCommitMessage(initialCommitMessage);
    setCommitMessage(initialCommitMessage);
  }

  const canPush = hasWorktree && !!pushRemote;
  // Knowing the forge is not the same as being able to post to it, and the two props must not be
  // able to disagree: an unconnected forge gets the invitation below, never the option.
  const canOpenPullRequest =
    canPush && !!pullRequestProvider && forgeSupportsPullRequests && !pullRequestNeedsConnecting;

  // The project's preference, honoured only where the option is actually on offer. A project set
  // to `PullRequest` whose forge is unconnected must not open on a radio that is not rendered.
  const preferred = landingMode ? STRATEGY_FOR_LANDING_MODE[landingMode] : "merge-delete";
  const defaultStrategy =
    (preferred === "pull-request" && !canOpenPullRequest) ||
    (preferred === "commit-push" && !canPush)
      ? "merge-delete"
      : preferred;

  const [strategy, setStrategy] = useState(defaultStrategy);
  // The code-hosting status arrives after the first render, so what is on offer changes under
  // this dialog and the default has to be re-applied when it does. Latched on the computed value
  // rather than on the prop, so a status refresh that changes nothing leaves a user's pick alone.
  const [prevDefaultStrategy, setPrevDefaultStrategy] = useState(defaultStrategy);
  if (prevDefaultStrategy !== defaultStrategy) {
    setPrevDefaultStrategy(defaultStrategy);
    setStrategy(defaultStrategy);
  }
  // Inviting someone to connect a forge that still could not open a pull request is worse than
  // saying nothing: the work it asks for changes nothing.
  const showConnectInvitation = pullRequestNeedsConnecting && forgeSupportsPullRequests;
  // Pushing is worth offering even when everything is already committed, which is why this
  // no longer keys off uncommitted changes alone.
  const showRadio = hasWorktree && (hasUncommitted || canPush);

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
          <>
            <RadioGroup value={strategy} onValueChange={setStrategy} className="gap-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <RadioGroupItem value="merge-delete" />
                Commit + Merge + Delete worktree
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <RadioGroupItem value="commit-only" />
                Commit only (keep worktree)
              </label>
              {canPush && (
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <RadioGroupItem value="commit-push" />
                  Commit + Push to {pushRemote}
                </label>
              )}
              {canOpenPullRequest && (
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <RadioGroupItem value="pull-request" />
                  Commit + Open a pull request
                </label>
              )}
            </RadioGroup>
            {/* An invitation, not an error. The forge is known but nothing has authenticated for
                it, and every other way of approving stays available. */}
            {showConnectInvitation && (
              <p className="text-xs text-muted-foreground">
                Connect {pullRequestProvider} in Settings to open a pull request from here.
              </p>
            )}
            {/* Every strategy approves the task, so all of them move it to Done. Worth saying,
                because keeping the worktree reads like the task is still in flight. */}
            <p className="text-xs text-muted-foreground">
              {strategy === "commit-only" &&
                "The task moves to Done. The branch stays unmerged and the worktree stays on disk for you to merge or push yourself."}
              {strategy === "commit-push" &&
                `The branch is pushed to ${pushRemote} and the task moves to Done. It stays unmerged, and the worktree stays on disk.`}
              {strategy === "pull-request" &&
                "The branch is pushed and a pull request opened. The task stays in Review until the pull request merges, and the worktree stays on disk until then."}
              {strategy === "merge-delete" && "The task moves to Done and the worktree is deleted."}
            </p>
          </>
        )}

        {untrackedCount > 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={includeUntracked}
                onCheckedChange={(v) => setIncludeUntracked(v === true)}
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
