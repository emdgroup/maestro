import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  GitMerge,
  GitCommitHorizontal,
  Upload,
  GitPullRequest,
} from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import { Checkbox } from "@/ui/checkbox";
import type { LandingMode } from "@/types/bindings";
import { PROVIDER_NAMES } from "@/services/integration.service";
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
              <div className="max-h-40 overflow-y-auto border-t divide-y">
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

/**
 * The strategy each landing mode asks for. `Merge` is also the fallback, so it is the value any
 * unavailable preference resolves to.
 */
const STRATEGY_FOR_LANDING_MODE: Record<LandingMode, string> = {
  Merge: "merge-delete",
  PullRequest: "pull-request",
  PushOnly: "commit-push",
};

/**
 * What each strategy does, in the order of how much of it Maestro performs. The labels match the
 * landing modes in Settings, which configures the default this dialog opens on — the same choice
 * described twice in different words is how the two drifted apart in the first place.
 *
 * A function of the remote because the push option names the remote it would actually push to,
 * which is not always `origin`.
 */
function strategiesFor(pushRemote?: string | null): {
  value: string;
  label: string;
  description: string;
  icon: typeof GitMerge;
}[] {
  return [
    {
      value: "merge-delete",
      label: "Merge locally",
      description: "Merge into the base branch, delete the worktree, move the task to Done",
      icon: GitMerge,
    },
    {
      value: "commit-only",
      label: "Commit only",
      description: "Leave the branch unmerged and the worktree on disk, move the task to Done",
      icon: GitCommitHorizontal,
    },
    {
      value: "commit-push",
      label: "Push only",
      description: `Push the branch to ${pushRemote ?? "the remote"}, keep the worktree, move the task to Done`,
      icon: Upload,
    },
    {
      value: "pull-request",
      label: "Open a pull request",
      description: "Push and open a pull request, keep the task in Review until it merges",
      icon: GitPullRequest,
    },
  ];
}

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
  // able to disagree: an unconnected forge gets the invitation below, never a selectable option.
  const canOpenPullRequest =
    canPush && !!pullRequestProvider && forgeSupportsPullRequests && !pullRequestNeedsConnecting;
  // Settings names forges by their display name; the raw id is an implementation detail and had
  // this dialog offering to connect "bitbucket".
  const providerName = pullRequestProvider
    ? (PROVIDER_NAMES[pullRequestProvider] ?? pullRequestProvider)
    : null;

  // The project's preference, honoured only where the option is actually on offer. A project set
  // to `PullRequest` whose forge is unconnected must not open on an option it cannot select.
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
  const showStrategy = hasWorktree && (hasUncommitted || canPush);

  const strategies = strategiesFor(pushRemote);
  const selected = strategies.find((s) => s.value === strategy) ?? strategies[0];
  const SelectedIcon = selected.icon;

  /**
   * Why a strategy cannot happen here, or null when it can. An unavailable option stays on screen
   * and disabled, so "why can't I open a pull request" has an answer where the question is asked.
   */
  function unavailableReason(value: string): string | null {
    if (value === "commit-push" && !canPush) return "This project has no remote to push to";
    if (value === "pull-request" && !canOpenPullRequest) {
      if (!canPush) return "This project has no remote to push to";
      if (!pullRequestProvider) return "Maestro does not recognise this host";
      if (!forgeSupportsPullRequests) return `Maestro cannot open pull requests on ${providerName}`;
      // Terse on purpose: the invitation below the control says where to go and what it buys.
      return "Not connected";
    }
    return null;
  }

  function getDescription(): string {
    if (hasWorktree && !hasUncommitted)
      return showStrategy
        ? // The select is on screen and may be set to push or open a pull request, so naming one
          // outcome here would contradict the control directly below it.
          "Changes in the worktree are committed."
        : "Changes are committed. This will merge the branch and delete the worktree.";
    if (!hasWorktree && hasUncommitted)
      return "Uncommitted changes will be committed and the task marked as done.";
    if (!hasWorktree && !hasUncommitted)
      return "All changes are committed. Task will be marked as done.";
    // No "choose how to…" here: the strategy select below carries its own label, and the two read
    // as two headings for the one control.
    return "Uncommitted changes in the worktree will be committed first.";
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

        {showStrategy && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">When this task is approved</p>
            <Select value={strategy} onValueChange={(next) => next && setStrategy(next)}>
              {/* See `WorkspaceModeSelect` on why the height override has to carry the size
                  variant. */}
              <SelectTrigger
                aria-label="When this task is approved"
                className="w-full data-[size=default]:h-auto py-2 px-3 border-border bg-transparent shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
              >
                <span className="flex items-center gap-2 min-w-0 flex-1 text-left">
                  <SelectedIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm truncate">{selected.label}</span>
                    <span className="block text-xs text-muted-foreground truncate">
                      {selected.description}
                    </span>
                  </span>
                </span>
              </SelectTrigger>
              <SelectContent>
                {strategies.map((option) => {
                  const Icon = option.icon;
                  const reason = unavailableReason(option.value);
                  return (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      disabled={reason !== null}
                      className="py-2"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block text-sm">{option.label}</span>
                          <span className="block text-xs text-muted-foreground">
                            {reason ?? option.description}
                          </span>
                        </span>
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {/* An invitation, not an error. The forge is known but nothing has authenticated for
                it, and every other way of approving stays available. */}
            {showConnectInvitation && (
              <p className="text-xs text-muted-foreground">
                Connect {providerName} in Settings to open a pull request from here.
              </p>
            )}
          </div>
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
            {isPending ? "Approving..." : showStrategy ? "Confirm" : getActionLabel()}
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
