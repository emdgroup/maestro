import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useActiveTab } from "@/store/navigationStore";
import { DiffModeEnum } from "@git-diff-view/react";
import { ChevronDown, TriangleAlert } from "lucide-react";
import { parseDiffString } from "@/lib/diff-utils";
import { DiffActionBar } from "./DiffActionBar";
import { DiffFilePanel } from "./DiffFilePanel";
import { DiffViewer, type PendingComment } from "./DiffViewer";
import { ScopeSelector, type DiffScope } from "./ScopeSelector";
import { UntrackedFileDiffViewer } from "./UntrackedFileDiffViewer";
import { ReworkModal, ApproveModal, DiscardModal } from "./ReviewConfirmModals";
import { buildReviewFeedbackBlocks } from "./build-review-feedback";
import { ReviewFileHeader } from "./ReviewFileHeader";
import { ReviewFileComment } from "./ReviewFileComment";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/ui/dropdown-menu";
import { useWorktreeDiffQuery, useWorktreeCommitsQuery } from "@/services/worktree.service";
import { useCancelActiveSessionMutation } from "@/services/execution.service";
import { DiffStateProvider } from "./DiffStateContext";
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
  const [fileListMode, setFileListMode] = useState<"flat" | "tree">("flat");
  const [fileSearch, setFileSearch] = useState("");
  const [selectedFileIndex, setSelectedFileIndex] = useState<number | null>(null);
  const [scope, setScope] = useState<DiffScope>({ type: "all" });
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(() =>
    reviewStore.getViewedFiles(task.id),
  );
  const [viewMode, setViewMode] = useState<"uncommitted" | "untracked">("uncommitted");

  // Comment state
  const [comments, setComments] = useState<PendingComment[]>(() =>
    reviewStore.getComments(task.id),
  );
  const [activeCommentLine, setActiveCommentLine] = useState<{
    lineNumber: number;
    side: "old" | "new";
  } | null>(null);
  const [activeFileComment, setActiveFileComment] = useState(false);

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

  // Map scope to DiffTarget
  // "All changes" uses execution_start_sha to show only task-specific changes,
  // not BranchAll which would include pre-existing differences from base branch.
  const diffTarget: DiffTarget = useMemo(() => {
    switch (scope.type) {
      case "all":
        if (startSha) return { type: "Commit", sha: startSha };
        if (baseBranch) return { type: "BranchAll", branch: baseBranch };
        return { type: "Head" };
      case "uncommitted":
        return { type: "Head" };
      case "commit":
        return { type: "CommitRange", from: scope.sha + "~1", to: scope.sha };
    }
  }, [scope, baseBranch, startSha]);

  // Data queries.
  // App.tsx keeps every view mounted, so ungated intervals would re-fetch and re-parse both of
  // these diffs every 10s for as long as the app runs — including while the user is on another
  // tab. Poll only while this view is on screen, then refetch on the way back in so returning
  // never shows a stale diff (same approach as WorktreesView's worktree list).
  const isViewActive = useActiveTab() === "kanban";
  const diffPolling = { refetchInterval: isViewActive ? 10000 : (false as const) };

  const diffQuery = useWorktreeDiffQuery(projectId, reviewPath, diffTarget, diffPolling);
  const uncommittedDiffQuery = useWorktreeDiffQuery(
    projectId,
    reviewPath,
    { type: "Head" },
    diffPolling,
  );

  const { refetch: refetchDiff } = diffQuery;
  const { refetch: refetchUncommittedDiff } = uncommittedDiffQuery;
  const wasViewActiveRef = useRef(isViewActive);
  useEffect(() => {
    if (isViewActive && !wasViewActiveRef.current) {
      void refetchDiff();
      void refetchUncommittedDiff();
    }
    wasViewActiveRef.current = isViewActive;
  }, [isViewActive, refetchDiff, refetchUncommittedDiff]);
  const commitsQuery = useWorktreeCommitsQuery(projectId, reviewPath, baseBranch);
  const commits = commitsQuery.data || [];

  // Parse diff to get structured file list. Read out of the optional chain first:
  // an optional member expression in a dependency array is opaque to the compiler
  // and drops the memoization.
  const diffText = diffQuery.data?.diff;
  const diffFiles = useMemo(() => (diffText ? parseDiffString(diffText) : []), [diffText]);

  // Uncommitted file count (stable regardless of selected scope)
  const uncommittedFileCount = useMemo(() => {
    const modifiedCount = uncommittedDiffQuery.data?.diff
      ? parseDiffString(uncommittedDiffQuery.data.diff).length
      : 0;
    const untrackedCount = uncommittedDiffQuery.data?.untracked_files?.length || 0;
    return modifiedCount + untrackedCount;
  }, [uncommittedDiffQuery.data]);

  // Untracked files from diff result
  const untrackedFiles = useMemo(() => diffQuery.data?.untracked_files ?? [], [diffQuery.data]);
  const totalFileCount = diffFiles.length + untrackedFiles.length;

  // Filter files by search
  const filteredDiffFiles = useMemo(() => {
    if (!fileSearch.trim()) return diffFiles;
    const q = fileSearch.toLowerCase();
    return diffFiles.filter((f) => f.fileName.toLowerCase().includes(q));
  }, [diffFiles, fileSearch]);

  // Derive selected untracked path when in untracked tab
  const selectedUntrackedPath =
    viewMode === "untracked" && selectedFileIndex !== null
      ? (untrackedFiles[selectedFileIndex] ?? null)
      : null;

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

  // Comment handlers
  const handleAddComment = useCallback((lineNumber: number, side: "old" | "new") => {
    setActiveCommentLine({ lineNumber, side });
  }, []);

  const handleSubmitComment = useCallback(
    (text: string) => {
      if (!activeCommentLine) return;
      const filePath =
        viewMode === "untracked"
          ? (selectedUntrackedPath ?? "")
          : (filteredDiffFiles[selectedFileIndex ?? -1]?.fileName ?? "");
      if (!filePath) return;
      setComments((prev) => {
        const existing = prev.findIndex(
          (c) =>
            c.filePath === filePath &&
            c.lineNumber === activeCommentLine.lineNumber &&
            c.side === activeCommentLine.side,
        );
        const newComment = {
          id: existing >= 0 ? prev[existing].id : crypto.randomUUID(),
          filePath,
          lineNumber: activeCommentLine.lineNumber,
          side: activeCommentLine.side,
          text,
        };
        if (existing >= 0) {
          const next = [...prev];
          next[existing] = newComment;
          return next;
        }
        return [...prev, newComment];
      });
      setActiveCommentLine(null);
    },
    [activeCommentLine, selectedFileIndex, filteredDiffFiles, viewMode, selectedUntrackedPath],
  );

  const handleRemoveComment = useCallback((commentId: string) => {
    setComments((prev) => prev.filter((c) => c.id !== commentId));
  }, []);

  const handleEditComment = useCallback((commentId: string, newText: string) => {
    setComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, text: newText } : c)));
  }, []);

  const handleFileComment = useCallback(
    (fileName: string) => {
      const fileIndex = filteredDiffFiles.findIndex((f) => f.fileName === fileName);
      if (fileIndex >= 0) {
        setSelectedFileIndex(fileIndex);
        setActiveFileComment(true);
      } else if (untrackedFiles.includes(fileName)) {
        setActiveFileComment(true);
      }
    },
    [filteredDiffFiles, untrackedFiles],
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

  // Current file for DiffViewer
  const selectedFile =
    selectedFileIndex != null ? (filteredDiffFiles[selectedFileIndex] ?? null) : null;
  const currentFileComments = selectedFile
    ? comments.filter((c) => c.filePath === selectedFile.fileName)
    : [];

  const forceUnified = selectedFile?.status === "A" || selectedFile?.status === "D";
  const effectiveDiffViewMode = forceUnified ? DiffModeEnum.Unified : diffViewMode;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Action Bar */}
      <DiffActionBar
        mode="review"
        branchName=""
        centerLabel={`Review: ${task.title}`}
        fileSearch={fileSearch}
        onFileSearchChange={setFileSearch}
        fileListMode={fileListMode}
        onFileListModeChange={setFileListMode}
        diffViewMode={diffViewMode}
        onDiffViewModeChange={setDiffViewMode}
        forceUnified={forceUnified}
        viewedCount={viewedFiles.size}
        totalFileCount={totalFileCount}
        splitButtonNode={
          <ButtonGroup>
            <Button
              variant={hasComments ? "outline" : "default"}
              size="sm"
              onClick={() => handleActionSelect(defaultAction)}
            >
              {hasComments ? "Rework" : "Approve"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant={hasComments ? "outline" : "default"}
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

      {/* Main content */}
      <DiffStateProvider
        viewMode={viewMode}
        setViewMode={setViewMode}
        selectedFileIndex={selectedFileIndex}
        setSelectedFileIndex={setSelectedFileIndex}
        fileListMode={fileListMode}
        setFileListMode={setFileListMode}
      >
        <div className="flex flex-1 min-h-0">
          {/* File sidebar */}
          <DiffFilePanel
            mode="review"
            modifiedCount={diffFiles.length}
            untrackedCount={untrackedFiles.length}
            diffLoading={diffQuery.isLoading}
            diffFiles={diffFiles}
            filteredDiffFiles={filteredDiffFiles}
            untrackedFiles={untrackedFiles}
            stagedFiles={new Set()}
            getFileCheckState={() => "unchecked"}
            onFileToggle={() => {}}
            onFolderToggle={() => {}}
            onToggleUntrackedFile={() => {}}
            hasAnyStaged={false}
            commitMessage=""
            onCommitMessageChange={() => {}}
            onCommit={() => {}}
            isCommitting={false}
            isStaging={false}
            onStageUntracked={async () => {}}
            viewedFiles={viewedFiles}
            onToggleViewed={toggleViewed}
            scopeSelector={
              <ScopeSelector
                selectedScope={scope}
                onScopeChange={setScope}
                commits={commits}
                uncommittedFileCount={uncommittedFileCount}
                totalFileCount={totalFileCount}
                isLoading={commitsQuery.isLoading}
              />
            }
            onFileComment={handleFileComment}
          />

          {/* Diff viewer */}
          <div className="flex-1 flex flex-col min-w-0">
            {viewMode === "untracked" && !selectedUntrackedPath && (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                Select a file to preview
              </div>
            )}

            {viewMode === "untracked" && selectedUntrackedPath && (
              <>
                <ReviewFileHeader
                  selectedFile={{ fileName: selectedUntrackedPath, hunks: [], status: "A" }}
                  viewedFiles={viewedFiles}
                  onToggleViewed={toggleViewed}
                  onFileComment={handleFileComment}
                />
                <ReviewFileComment
                  selectedFile={{ fileName: selectedUntrackedPath, hunks: [], status: "A" }}
                  comments={comments}
                  activeFileComment={activeFileComment}
                  setActiveFileComment={setActiveFileComment}
                  onRemoveComment={handleRemoveComment}
                  onEditComment={handleEditComment}
                  setComments={setComments}
                />
                <UntrackedFileDiffViewer
                  projectId={projectId}
                  worktreePath={reviewPath}
                  filePath={selectedUntrackedPath}
                  showHeader={false}
                  reviewMode={true}
                  comments={comments.filter((c) => c.filePath === selectedUntrackedPath)}
                  activeCommentLine={activeCommentLine}
                  onAddComment={handleAddComment}
                  onRemoveComment={handleRemoveComment}
                  onEditComment={handleEditComment}
                  onCancelComment={() => setActiveCommentLine(null)}
                  onSubmitComment={handleSubmitComment}
                />
              </>
            )}

            {viewMode === "uncommitted" && (
              <>
                {/* File content header */}
                {selectedFile && (
                  <ReviewFileHeader
                    selectedFile={selectedFile}
                    viewedFiles={viewedFiles}
                    onToggleViewed={toggleViewed}
                    onFileComment={handleFileComment}
                  />
                )}

                {/* File-level comment (single per file, editable) */}
                {selectedFile && (
                  <ReviewFileComment
                    selectedFile={selectedFile}
                    comments={comments}
                    activeFileComment={activeFileComment}
                    setActiveFileComment={setActiveFileComment}
                    onRemoveComment={handleRemoveComment}
                    onEditComment={handleEditComment}
                    setComments={setComments}
                  />
                )}

                <div className="flex-1 min-h-0 overflow-auto custom-scrollbar">
                  {diffQuery.isLoading ? (
                    <DiffViewer
                      diffFile={null}
                      loading={true}
                      diffViewMode={effectiveDiffViewMode}
                    />
                  ) : selectedFile ? (
                    <DiffViewer
                      diffFile={selectedFile}
                      loading={false}
                      diffViewMode={effectiveDiffViewMode}
                      reviewMode={true}
                      comments={currentFileComments}
                      onAddComment={handleAddComment}
                      onRemoveComment={handleRemoveComment}
                      onEditComment={handleEditComment}
                      onCancelComment={() => setActiveCommentLine(null)}
                      onSubmitComment={handleSubmitComment}
                    />
                  ) : (
                    <DiffViewer
                      diffFile={null}
                      loading={false}
                      diffViewMode={effectiveDiffViewMode}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </DiffStateProvider>

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
        forgeSupportsPullRequests={codeHostingQuery.data?.forge_supports_pull_requests ?? false}
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
