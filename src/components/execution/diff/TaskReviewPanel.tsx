import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useActiveTab } from "@/store/navigationStore";
import { DiffModeEnum } from "@git-diff-view/react";
import { ChevronDown, TriangleAlert } from "lucide-react";
import { parseDiffString } from "@/lib/diff-utils";
import { cn } from "@/lib/utils.ts";
import { DiffActionBar } from "./DiffActionBar";
import { type PendingComment } from "./DiffViewer";
import { DiffFileStack, type DiffFileStackHandle, type DiffReviewApi } from "./DiffFileStack";
import { ReviewLayout, FilePanelToggle } from "./ReviewLayout";
import { ScopeSelector } from "./ScopeSelector";
import { scopeToDiffTarget, type DiffScope } from "./scope";
import { useReviewItems, fileCountFrom } from "./useReviewItems";
import { useReviewPanelLayout } from "./useReviewPanelLayout";
import { ReworkModal, ApproveModal, DiscardModal } from "./ReviewConfirmModals";
import { buildReviewFeedbackBlocks } from "./build-review-feedback";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/ui/dropdown-menu";
import {
  useWorktreeDiffQuery,
  useWorktreeDiffStatsQuery,
  useWorktreeCommitsQuery,
} from "@/services/worktree.service";
import { useCancelActiveSessionMutation } from "@/services/execution.service";
import {
  useRequestChangesMutation,
  useApproveTaskAndMergeMutation,
  useRejectReviewMutation,
  useSaveTaskReviewMutation,
  useResolveCommitMessageQuery,
} from "@/services/task.service";
import { useExecuteTask, useTaskActiveSession } from "@/hooks/useExecuteTask";
import { DirtyWorktreeDialog } from "@/components/execution/DirtyWorktreeDialog";
import { useKanban } from "@/contexts/KanbanContext";
import { useCodeHostingStatus } from "@/services/integration.service";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { useReviewStore } from "@/store/reviewStore";
import { api } from "@/utils/helpers/tauri-utils";
import { displayItemPath } from "@/types/review";
import type { DiffTarget, MergeResult, Task } from "@/types/bindings";

/** The approve modal's radio values, mapped to what `approve_task_and_merge` expects. */
const MERGE_STRATEGIES: Record<string, string> = {
  "commit-only": "CommitOnly",
  "commit-push": "CommitAndPush",
  "pull-request": "CreatePullRequest",
  "merge-delete": "CommitAndMerge",
};

interface TaskReviewPanelProps {
  task: Task;
  /// Where to run git for this review — the worktree, or the project itself when the task runs
  /// without one. Everything that reads the code uses this.
  reviewPath: string | null;
  /// The worktree, if the task has one. Only things that act on the worktree as an object — the
  /// approve strategy, the discard warning — may use this.
  worktreePath: string | null;
  baseBranch: string | null;
  branchName: string | null;
  onClose: () => void;
}

export function TaskReviewPanel({
  task,
  reviewPath,
  worktreePath,
  baseBranch,
  branchName,
  onClose,
}: TaskReviewPanelProps) {
  const { projectId, projectPath, connection } = useKanban();
  const reviewStore = useReviewStore();
  const startSha = task.execution_start_sha ?? null;

  // View state
  const [diffViewMode, setDiffViewMode] = useState(DiffModeEnum.Unified);
  const [fileSearch, setFileSearch] = useState("");
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [scope, setScope] = useState<DiffScope>({ type: "all" });
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(() =>
    reviewStore.getViewedFiles(task.id),
  );
  const stackRef = useRef<DiffFileStackHandle>(null);
  const panel = useReviewPanelLayout();

  // Comment state
  const [comments, setComments] = useState<PendingComment[]>(() =>
    reviewStore.getComments(task.id),
  );

  // Sync comments to store
  useEffect(() => {
    reviewStore.setComments(task.id, comments);
  }, [comments, task.id, reviewStore]);

  // Modal state
  const [reworkModalOpen, setReworkModalOpen] = useState(false);
  const [approveModalOpen, setApproveModalOpen] = useState(false);
  const [discardModalOpen, setDiscardModalOpen] = useState(false);

  const commitMessageQuery = useResolveCommitMessageQuery(task.id, approveModalOpen);

  // Mutations
  const { mutate: saveReview, isPending: isSaving } = useSaveTaskReviewMutation();
  const { mutate: approveAndMerge, isPending: isApproving } = useApproveTaskAndMergeMutation();
  const { mutate: rejectReview, isPending: isRejecting } = useRejectReviewMutation();
  const { mutate: requestChanges, isPending: isRequestingChanges } = useRequestChangesMutation();
  const {
    execute,
    dirtyDialogOpen,
    dirtyModifiedCount,
    dirtyUntrackedCount,
    onDirtyChoice,
    onDirtyCancel,
  } = useExecuteTask(projectId, projectPath, connection);
  const activeSession = useTaskActiveSession(task.id, projectId);
  const codeHostingQuery = useCodeHostingStatus(projectId);
  const cancelSession = useCancelActiveSessionMutation();

  // "All changes" uses execution_start_sha to show only task-specific changes, not BranchAll which
  // would include pre-existing differences from the base branch.
  const scopeAnchors = useMemo(() => ({ startSha, baseBranch }), [startSha, baseBranch]);
  const diffTarget: DiffTarget = useMemo(
    () => scopeToDiffTarget(scope, scopeAnchors),
    [scope, scopeAnchors],
  );
  const allChangesTarget: DiffTarget = useMemo(
    () => scopeToDiffTarget({ type: "all" }, scopeAnchors),
    [scopeAnchors],
  );

  // Data queries.
  // App.tsx keeps every view mounted, so ungated intervals would re-fetch and re-parse both of
  // these diffs every 10s for as long as the app runs — including while the user is on another
  // tab. Poll only while this view is on screen, then refetch on the way back in so returning
  // never shows a stale diff (same approach as WorktreesView's worktree list).
  const isViewActive = useActiveTab() === "kanban";
  const diffPolling = { refetchInterval: isViewActive ? 10000 : (false as const) };

  const diffQuery = useWorktreeDiffQuery(projectId, reviewPath, diffTarget, diffPolling);

  // The scope selector's two fixed rows describe scopes other than the one on screen, so their
  // counts come from their own queries — a count derived from the current diff changed every time
  // the scope did, which made the options look like they meant something different each visit.
  // `--stat` rather than a second full diff: the only thing wanted here is an integer. When the
  // selected scope *is* "all", this resolves to the same target and TanStack shares the fetch.
  const uncommittedStats = useWorktreeDiffStatsQuery(
    projectId,
    reviewPath,
    { type: "Head" },
    diffPolling,
  );
  const allChangesStats = useWorktreeDiffStatsQuery(
    projectId,
    reviewPath,
    allChangesTarget,
    diffPolling,
  );

  const { refetch: refetchDiff } = diffQuery;
  const wasViewActiveRef = useRef(isViewActive);
  useEffect(() => {
    if (isViewActive && !wasViewActiveRef.current) void refetchDiff();
    wasViewActiveRef.current = isViewActive;
  }, [isViewActive, refetchDiff]);
  const commitsQuery = useWorktreeCommitsQuery(projectId, reviewPath, baseBranch);
  const commits = commitsQuery.data || [];

  // Parse diff to get structured file list. Read out of the optional chain first:
  // an optional member expression in a dependency array is opaque to the compiler
  // and drops the memoization.
  const diffText = diffQuery.data?.diff;
  const diffFiles = useMemo(() => (diffText ? parseDiffString(diffText) : []), [diffText]);

  // Untracked files from diff result
  const untrackedFiles = useMemo(() => diffQuery.data?.untracked_files ?? [], [diffQuery.data]);
  const scopeFileCount = diffFiles.length + untrackedFiles.length;

  const { items, panelFiles, selectFile, selectedPath } = useReviewItems({
    diffFiles,
    untrackedFiles,
    search: fileSearch,
    selectedIndex: selectedFileIndex,
    stackRef,
  });

  // Viewed toggle — sync to store
  const toggleViewed = useCallback(
    (fileName: string) => {
      setViewedFiles((prev) => {
        const next = new Set(prev);
        if (next.has(fileName)) next.delete(fileName);
        else next.add(fileName);
        reviewStore.setViewedFiles(task.id, next);
        return next;
      });
    },
    [task.id, reviewStore],
  );

  const handleRemoveComment = useCallback((commentId: string) => {
    setComments((prev) => prev.filter((c) => c.id !== commentId));
  }, []);

  const handleEditComment = useCallback((commentId: string, newText: string) => {
    setComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, text: newText } : c)));
  }, []);

  const handleSubmitComment = useCallback(
    (filePath: string, lineNumber: number, side: "old" | "new", text: string) => {
      setComments((prev) => {
        const at = prev.findIndex(
          (c) => c.filePath === filePath && c.lineNumber === lineNumber && c.side === side,
        );
        if (at >= 0) {
          const next = [...prev];
          next[at] = { ...next[at], text };
          return next;
        }
        return [...prev, { id: crypto.randomUUID(), filePath, lineNumber, side, text }];
      });
    },
    [],
  );

  // Review comments leave as one Rework payload rather than one at a time, so no `onSendComment`.
  const review: DiffReviewApi = useMemo(
    () => ({
      comments,
      onSubmitComment: handleSubmitComment,
      onRemoveComment: handleRemoveComment,
      onEditComment: handleEditComment,
    }),
    [comments, handleSubmitComment, handleRemoveComment, handleEditComment],
  );

  /**
   * A comment can sit on a file the search box is currently hiding. Stepping to it has to put the
   * file back in the list first, or the chevron leads nowhere.
   */
  const handleBeforeReveal = useCallback(
    (path: string) => {
      if (!items.some((item) => displayItemPath(item) === path)) setFileSearch("");
    },
    [items],
  );

  // Multi-state button logic
  const hasComments = comments.length > 0;
  const defaultAction = hasComments ? "rework" : "approve";

  const handleActionSelect = useCallback((value: string) => {
    switch (value) {
      case "approve":
        setApproveModalOpen(true);
        break;
      case "rework":
        setReworkModalOpen(true);
        break;
      case "discard":
        setDiscardModalOpen(true);
        break;
    }
  }, []);

  // Mutation handlers (called from modals)
  const handleReworkConfirm = useCallback(
    (data: { comments: PendingComment[]; generalFeedback: string }) => {
      const perFileComments: Array<[string, string]> = data.comments.map((c) => [
        c.filePath,
        c.lineNumber > 0 ? `line:${c.lineNumber} — ${c.text}` : c.text,
      ]);
      requestChanges(
        {
          taskId: task.id,
          generalFeedback: data.generalFeedback || null,
          perFileComments: perFileComments.length > 0 ? perFileComments : null,
        },
        {
          onSuccess: async () => {
            setReworkModalOpen(false);
            if (activeSession) {
              const blocks = buildReviewFeedbackBlocks(data);
              await api.sendAcpPromptStructured(activeSession.session_key, blocks);
            } else {
              execute(task);
            }
            api.clearTaskReview(task.id).catch(() => {});
            reviewStore.clearTask(task.id);
            onClose();
          },
        },
      );
    },
    [task, requestChanges, onClose, execute, activeSession, reviewStore],
  );

  const handleApproveConfirm = useCallback(
    (data: { mergeStrategy: string; includeUntracked: boolean; commitMessage: string }) => {
      saveReview(
        { taskId: task.id, decision: "Approve", generalFeedback: null, perFileComments: null },
        {
          onSuccess: () => {
            const strategy = MERGE_STRATEGIES[data.mergeStrategy] ?? "CommitAndMerge";
            approveAndMerge(
              {
                taskId: task.id,
                mergeStrategy: strategy,
                includeUntracked: data.includeUntracked,
                commitMessage: data.commitMessage,
              },
              {
                onSuccess: (raw) => {
                  const result = raw as MergeResult;
                  // The session closes on every approve path, including the pull-request one:
                  // a PR sitting over a weekend would pin a host slot the whole time.
                  if (activeSession) {
                    cancelSession.mutate({
                      sessionKey: activeSession.session_key,
                      executionMode: activeSession.execution_mode,
                    });
                  }
                  if (result?.pull_request_url) {
                    const url = result.pull_request_url;
                    toast.success("Pull request opened", {
                      action: { label: "Open", onClick: () => void openUrl(url) },
                    });
                  }
                  setApproveModalOpen(false);
                  reviewStore.clearTask(task.id);
                  onClose();
                },
              },
            );
          },
        },
      );
    },
    [task.id, saveReview, approveAndMerge, onClose, reviewStore, activeSession, cancelSession],
  );

  const handleDiscardConfirm = useCallback(
    (action: "backlog" | "cancel") => {
      rejectReview(
        {
          taskId: task.id,
          action: action === "backlog" ? "SendToBacklog" : "CancelTask",
        },
        {
          onSuccess: () => {
            setDiscardModalOpen(false);
            reviewStore.clearTask(task.id);
            onClose();
          },
        },
      );
    },
    [task.id, rejectReview, onClose, reviewStore],
  );

  // Detect worktree state for ApproveModal
  const hasWorktree = worktreePath != null;
  const hasUncommitted =
    (diffQuery.data?.untracked_files?.length ?? 0) > 0 ||
    diffFiles.some((f) => f.status === "M" || f.status === "A" || f.status === "D");

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Action Bar. The gap below it belongs to the diff's inset, so it takes a matching one
          above rather than sitting high in its own band. */}
      <div className={cn("shrink-0 bg-card", panel.inset && "pt-2")}>
        <DiffActionBar
          mode="review"
          branchName=""
          centerLabel={`Review: ${task.title}`}
          className="bg-card border-b-0"
          leadingSlot={
            <>
              <FilePanelToggle
                open={panel.panelOpen}
                onToggle={() => panel.setPanelOpen(!panel.panelOpen)}
              />
              <ScopeSelector
                selectedScope={scope}
                onScopeChange={setScope}
                commits={commits}
                uncommittedFileCount={fileCountFrom(uncommittedStats.data)}
                allChangesFileCount={fileCountFrom(allChangesStats.data)}
                isLoading={commitsQuery.isLoading}
              />
            </>
          }
          diffViewMode={diffViewMode}
          onDiffViewModeChange={setDiffViewMode}
          viewedCount={viewedFiles.size}
          totalFileCount={scopeFileCount}
          splitButtonNode={
            <ButtonGroup>
              <Button
                variant={hasComments ? "outline" : "accent"}
                size="sm"
                onClick={() => handleActionSelect(defaultAction)}
              >
                {hasComments ? "Rework" : "Approve"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant={hasComments ? "outline" : "accent"}
                      size="sm"
                      className="px-1.5!"
                    >
                      <ChevronDown className="size-3.5" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="w-40">
                  {defaultAction !== "approve" && (
                    <DropdownMenuItem onClick={() => handleActionSelect("approve")}>
                      Approve
                    </DropdownMenuItem>
                  )}
                  {defaultAction !== "rework" && (
                    <DropdownMenuItem onClick={() => handleActionSelect("rework")}>
                      Rework
                    </DropdownMenuItem>
                  )}
                  {/* A task keeps its agent session into Review. Ending it leaves the task here —
                    the work is done and under review, the session is just a process still held. */}
                  {activeSession && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={cancelSession.isPending}
                        onClick={() =>
                          cancelSession.mutate({
                            sessionKey: activeSession.session_key,
                            executionMode: activeSession.execution_mode,
                          })
                        }
                      >
                        End session
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => handleActionSelect("discard")}
                  >
                    Discard
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </ButtonGroup>
          }
          onClose={onClose}
        />
      </div>

      {(diffQuery.data?.diff_truncated || diffQuery.data?.untracked_truncated) && (
        <div className="flex items-start gap-2 px-3 py-2 border-b border-border bg-amber-500/5 text-amber-400 shrink-0 text-xs">
          <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">Diff too large — partial view</span>
            <span className="text-amber-400/70">
              {diffQuery.data.diff_truncated &&
                `Diff: ${Math.round(diffQuery.data.total_diff_bytes / 1_048_576)} MB total, showing first 2 MB. `}
              {diffQuery.data.untracked_truncated &&
                `Untracked: ${diffQuery.data.total_untracked.toLocaleString()} files, showing first 500.`}
            </span>
          </div>
        </div>
      )}

      {/* Main content. The panel sits beside the stack when there is room for both and floats
          over it when there is not — same toggle either way. */}
      <ReviewLayout
        panel={panel}
        files={{
          files: panelFiles,
          selectedFile: selectedPath,
          onSelectFile: selectFile,
          viewedFiles,
          search: fileSearch,
          onSearchChange: setFileSearch,
        }}
      >
        <DiffFileStack
          ref={stackRef}
          items={items}
          projectId={projectId}
          cwd={reviewPath}
          diffViewMode={diffViewMode}
          selectedIndex={selectedFileIndex}
          onSelectedIndexChange={setSelectedFileIndex}
          viewedFiles={viewedFiles}
          onToggleViewed={toggleViewed}
          review={review}
          onBeforeReveal={handleBeforeReveal}
          loading={diffQuery.isLoading}
          emptyMessage={fileSearch.trim() ? "No files match" : "No changes to review"}
        />
      </ReviewLayout>

      {/* Confirmation Modals */}
      <ReworkModal
        open={reworkModalOpen}
        onOpenChange={setReworkModalOpen}
        comments={comments}
        onConfirm={handleReworkConfirm}
        isPending={isRequestingChanges}
      />
      <ApproveModal
        open={approveModalOpen}
        onOpenChange={setApproveModalOpen}
        hasWorktree={hasWorktree}
        hasUncommitted={hasUncommitted}
        untrackedCount={untrackedFiles.length}
        commitMessage={commitMessageQuery.data ?? ""}
        pushRemote={codeHostingQuery.data?.remote}
        pullRequestProvider={codeHostingQuery.data?.config?.provider}
        pullRequestNeedsConnecting={codeHostingQuery.data?.rung === "NotConnected"}
        onConfirm={handleApproveConfirm}
        isPending={isSaving || isApproving}
      />
      <DiscardModal
        open={discardModalOpen}
        onOpenChange={setDiscardModalOpen}
        worktreePath={worktreePath}
        branchName={branchName}
        commitCount={commits.length}
        onConfirm={handleDiscardConfirm}
        isPending={isRejecting}
      />
      <DirtyWorktreeDialog
        open={dirtyDialogOpen}
        modifiedCount={dirtyModifiedCount}
        untrackedCount={dirtyUntrackedCount}
        onChoice={onDirtyChoice}
        onCancel={onDirtyCancel}
      />
    </div>
  );
}
