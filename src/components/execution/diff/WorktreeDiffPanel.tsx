import { useState, useMemo, useCallback } from "react";
import { DiffModeEnum } from "@git-diff-view/react";
import { CheckCheck } from "lucide-react";
import { parseDiffString, computeFileStats, countHunks } from "@/lib/diff-utils";
import { useWorktreeDiffActions } from "./useWorktreeDiffActions";
import { cn } from "@/lib/utils.ts";
import { Button } from "@/ui/button";
import { ScrollArea } from "@/ui/scroll-area";
import { DiffViewer } from "./DiffViewer";
import { DiffActionBar } from "./DiffActionBar";
import { DiffFilePanel } from "./DiffFilePanel";
import { ScopeSelector } from "./ScopeSelector";
import type { DiffScope } from "./ScopeSelector";
import { useStagingState } from "../worktree-card/useStagingState";
import { DiffStateProvider } from "./DiffStateContext";
import { UntrackedFileDiffViewer } from "./UntrackedFileDiffViewer";
import {
  useWorktreeDiffQuery,
  useWorktreeCommitsQuery,
  useStageWorktreeFilesMutation,
  useCommitWorktreeMutation,
  useDiscardWorktreeChangesMutation,
  useShelveWorktreeChangesMutation,
  useDeleteUntrackedFilesMutation,
} from "@/services/worktree.service";
import type { WorktreeWithStatus, DiffTarget } from "@/types/bindings";

interface WorktreeDiffPanelProps {
  worktree: WorktreeWithStatus | null;
  projectId: number | null;
  onClose: () => void;
}

export function WorktreeDiffPanel({ worktree, projectId, onClose }: WorktreeDiffPanelProps) {
  const [diffViewMode, setDiffViewMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);
  const [viewMode, setViewMode] = useState<"uncommitted" | "untracked">("uncommitted");
  const [fileListMode, setFileListMode] = useState<"flat" | "tree">("flat");
  const [scope, setScope] = useState<DiffScope>({ type: "uncommitted" });
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());

  const toggleViewed = useCallback((fileName: string) => {
    setViewedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });
  }, []);

  const worktreePath = worktree?.path ?? null;
  const baseBranch = worktree?.base_branch ?? null;

  const isUncommittedScope = scope.type === "uncommitted";

  const diffTarget: DiffTarget = useMemo(() => {
    switch (scope.type) {
      case "uncommitted":
        return { type: "Head" };
      case "all":
        return baseBranch ? { type: "BranchAll", branch: baseBranch } : { type: "Head" };
      case "commit":
        return { type: "CommitRange", from: scope.sha + "~1", to: scope.sha };
    }
  }, [scope, baseBranch]);

  const commitsQuery = useWorktreeCommitsQuery(projectId, worktreePath, baseBranch);
  const commits = commitsQuery.data || [];

  const {
    data: diffResult,
    isLoading: diffLoading,
    error: diffError,
  } = useWorktreeDiffQuery(projectId, worktreePath, diffTarget);

  const diffString = diffResult?.diff ?? null;
  const untrackedFiles = diffResult?.untracked_files ?? [];

  const stageMutation = useStageWorktreeFilesMutation();
  const commitMutation = useCommitWorktreeMutation();
  const discardMutation = useDiscardWorktreeChangesMutation();
  const shelveMutation = useShelveWorktreeChangesMutation();
  const deleteMutation = useDeleteUntrackedFilesMutation();
  const [shelvePopoverOpen, setShelvePopoverOpen] = useState(false);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  function handleDeleteDialogOpenChange(open: boolean) {
    if (!open) deleteMutation.reset();
    setDeleteDialogOpen(open);
  }

  const diffFiles = useMemo(() => {
    if (!diffString) return [];
    return parseDiffString(diffString);
  }, [diffString]);

  const {
    stagedFiles,
    setStagedFiles,
    stagedHunks,
    setStagedHunks,
    commitMessage,
    setCommitMessage,
    shelveName,
    setShelveName,
    selectedFileIndex,
    setSelectedFileIndex,
    fileSearch,
    setFileSearch,
  } = useStagingState(worktreePath, viewMode, worktree, diffFiles);

  const selectedUntrackedPath =
    viewMode === "untracked" && selectedFileIndex !== null
      ? (untrackedFiles[selectedFileIndex] ?? null)
      : null;

  const filteredDiffFiles = useMemo(() => {
    if (!fileSearch.trim()) return diffFiles;
    const q = fileSearch.toLowerCase();
    return diffFiles.filter((f) => f.fileName.toLowerCase().includes(q));
  }, [diffFiles, fileSearch]);

  const hasAnyStaged = stagedFiles.size > 0 || [...stagedHunks.values()].some((s) => s.size > 0);

  function getFileCheckState(fileName: string): "checked" | "unchecked" | "indeterminate" {
    if (stagedFiles.has(fileName)) return "checked";
    const hunkSet = stagedHunks.get(fileName);
    if (!hunkSet || hunkSet.size === 0) return "unchecked";
    const file = diffFiles.find((f) => f.fileName === fileName);
    if (!file) return "unchecked";
    const totalHunks = countHunks(file.hunks[0] ?? "");
    if (totalHunks > 0 && hunkSet.size >= totalHunks) return "checked";
    return "indeterminate";
  }

  function handleFileToggle(fileName: string) {
    const state = getFileCheckState(fileName);
    if (state === "checked") {
      setStagedFiles((prev) => {
        const n = new Set(prev);
        n.delete(fileName);
        return n;
      });
      setStagedHunks((prev) => {
        const n = new Map(prev);
        n.delete(fileName);
        return n;
      });
    } else {
      setStagedFiles((prev) => new Set(prev).add(fileName));
      setStagedHunks((prev) => {
        const n = new Map(prev);
        n.delete(fileName);
        return n;
      });
    }
  }

  function handleFolderToggle(fileNames: string[]) {
    const allChecked = fileNames.every((f) => getFileCheckState(f) === "checked");
    if (allChecked) {
      setStagedFiles((prev) => {
        const n = new Set(prev);
        fileNames.forEach((f) => n.delete(f));
        return n;
      });
      setStagedHunks((prev) => {
        const n = new Map(prev);
        fileNames.forEach((f) => n.delete(f));
        return n;
      });
    } else {
      setStagedFiles((prev) => {
        const n = new Set(prev);
        fileNames.forEach((f) => n.add(f));
        return n;
      });
      setStagedHunks((prev) => {
        const n = new Map(prev);
        fileNames.forEach((f) => n.delete(f));
        return n;
      });
    }
  }

  function handleHunkToggle(fileName: string, hunkIndex: number) {
    setStagedHunks((prev) => {
      const n = new Map(prev);
      const existing = n.get(fileName) ?? new Set<number>();
      const updated = new Set(existing);
      if (updated.has(hunkIndex)) {
        updated.delete(hunkIndex);
      } else {
        updated.add(hunkIndex);
      }
      if (updated.size === 0) {
        n.delete(fileName);
      } else {
        n.set(fileName, updated);
      }
      return n;
    });
  }

  const { handleRevert, handleShelve, handleCommit, handleStageUntracked, handleDeleteUntracked } =
    useWorktreeDiffActions({
      projectId,
      worktreePath,
      stagedFiles,
      setStagedFiles,
      stagedHunks,
      setStagedHunks,
      diffFiles,
      commitMessage,
      setCommitMessage,
      shelveName,
      setShelvePopoverOpen,
      setDiscardDialogOpen,
      setDeleteDialogOpen,
      stageMutation,
      commitMutation,
      discardMutation,
      shelveMutation,
      deleteMutation,
      onClose,
    });

  function handleToggleUntrackedFile(filePath: string) {
    setStagedFiles((prev) => {
      const n = new Set(prev);
      if (n.has(filePath)) n.delete(filePath);
      else n.add(filePath);
      return n;
    });
  }

  const selectedFile = selectedFileIndex !== null ? (diffFiles[selectedFileIndex] ?? null) : null;
  const forceUnified = selectedFile?.status === "A" || selectedFile?.status === "D";
  const effectiveDiffViewMode = forceUnified ? DiffModeEnum.Unified : diffViewMode;

  // No-op helpers for read-only (non-uncommitted) scopes
  const noopFileToggle = () => {};
  const noopFolderToggle = () => {};
  const noopGetFileCheckState = (): "unchecked" => "unchecked";

  if (worktree === null) {
    return null;
  }

  return (
    <div className="flex flex-col h-full">
      <DiffActionBar
        mode="worktree"
        branchName={worktree.branch_name}
        fileSearch={fileSearch}
        onFileSearchChange={setFileSearch}
        fileListMode={fileListMode}
        onFileListModeChange={setFileListMode}
        diffViewMode={diffViewMode}
        onDiffViewModeChange={setDiffViewMode}
        forceUnified={forceUnified}
        hasAnyStaged={isUncommittedScope ? hasAnyStaged : false}
        isDiscarding={isUncommittedScope ? discardMutation.isPending : false}
        isDeleteMode={isUncommittedScope && viewMode === "untracked"}
        discardDialogOpen={isUncommittedScope ? discardDialogOpen : false}
        onDiscardDialogOpenChange={isUncommittedScope ? setDiscardDialogOpen : undefined}
        deleteDialogOpen={isUncommittedScope ? deleteDialogOpen : false}
        onDeleteDialogOpenChange={isUncommittedScope ? handleDeleteDialogOpenChange : undefined}
        isDeleting={isUncommittedScope ? deleteMutation.isPending : false}
        deleteError={
          isUncommittedScope && deleteMutation.error ? String(deleteMutation.error) : null
        }
        isShelving={isUncommittedScope ? shelveMutation.isPending : false}
        shelvePopoverOpen={isUncommittedScope ? shelvePopoverOpen : false}
        onShelvePopoverOpenChange={isUncommittedScope ? setShelvePopoverOpen : undefined}
        shelveName={isUncommittedScope ? shelveName : ""}
        onShelveNameChange={isUncommittedScope ? setShelveName : undefined}
        onRevert={
          isUncommittedScope
            ? viewMode === "untracked"
              ? handleDeleteUntracked
              : handleRevert
            : undefined
        }
        onShelve={isUncommittedScope ? handleShelve : undefined}
        onClose={onClose}
      />

      <DiffStateProvider
        viewMode={viewMode}
        setViewMode={setViewMode}
        selectedFileIndex={selectedFileIndex}
        setSelectedFileIndex={setSelectedFileIndex}
        fileListMode={fileListMode}
        setFileListMode={setFileListMode}
      >
        <div className="flex flex-1 min-h-0">
          <DiffFilePanel
            mode="worktree"
            modifiedCount={diffFiles.length}
            untrackedCount={untrackedFiles.length}
            diffLoading={diffLoading}
            diffFiles={diffFiles}
            filteredDiffFiles={filteredDiffFiles}
            untrackedFiles={untrackedFiles}
            stagedFiles={isUncommittedScope ? stagedFiles : new Set<string>()}
            getFileCheckState={isUncommittedScope ? getFileCheckState : noopGetFileCheckState}
            onFileToggle={isUncommittedScope ? handleFileToggle : noopFileToggle}
            onFolderToggle={isUncommittedScope ? handleFolderToggle : noopFolderToggle}
            onToggleUntrackedFile={isUncommittedScope ? handleToggleUntrackedFile : noopFileToggle}
            hasAnyStaged={isUncommittedScope ? hasAnyStaged : false}
            commitMessage={isUncommittedScope ? commitMessage : ""}
            onCommitMessageChange={isUncommittedScope ? setCommitMessage : noopFileToggle}
            onCommit={isUncommittedScope ? handleCommit : noopFileToggle}
            isCommitting={isUncommittedScope ? commitMutation.isPending : false}
            isStaging={isUncommittedScope ? stageMutation.isPending : false}
            onStageUntracked={isUncommittedScope ? handleStageUntracked : async () => {}}
            viewedFiles={viewedFiles}
            onToggleViewed={toggleViewed}
            scopeSelector={
              <ScopeSelector
                selectedScope={scope}
                onScopeChange={setScope}
                commits={commits}
                uncommittedFileCount={untrackedFiles.length + diffFiles.length}
                totalFileCount={diffFiles.length + untrackedFiles.length}
                isLoading={commitsQuery.isLoading}
              />
            }
          />

          {/* Right diff body */}
          <div className="flex-1 flex flex-col min-w-0">
            {viewMode === "untracked" && !selectedUntrackedPath && (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                Select a file to preview
              </div>
            )}

            {viewMode === "untracked" && selectedUntrackedPath && (
              <UntrackedFileDiffViewer
                projectId={projectId}
                worktreePath={worktreePath}
                filePath={selectedUntrackedPath}
              />
            )}

            {viewMode === "uncommitted" &&
              selectedFile &&
              (() => {
                const stats = computeFileStats(selectedFile.hunks);
                const status = selectedFile.status ?? "M";
                const statusColor =
                  status === "A"
                    ? "text-success"
                    : status === "D"
                      ? "text-destructive"
                      : "text-muted-foreground";
                const isViewed = viewedFiles.has(selectedFile.fileName);
                return (
                  <div className="px-3 py-1.5 border-b border-border bg-muted/20 shrink-0 flex items-center gap-2 text-xs">
                    <span className="font-mono text-foreground truncate flex-1">
                      {selectedFile.fileName}
                    </span>
                    <span className={cn("font-medium shrink-0", statusColor)}>{status}</span>
                    {stats.insertions > 0 && (
                      <span className="text-success shrink-0">+{stats.insertions}</span>
                    )}
                    {stats.deletions > 0 && (
                      <span className="text-destructive shrink-0">-{stats.deletions}</span>
                    )}
                    <Button
                      variant="ghost"
                      onClick={() => toggleViewed(selectedFile.fileName)}
                      className={cn(
                        "flex items-center gap-1 px-1.5 py-0.5 h-auto rounded border border-border hover:bg-muted/30",
                        isViewed ? "text-success" : "text-muted-foreground hover:text-foreground",
                      )}
                      title={isViewed ? "Mark as unviewed" : "Mark as viewed"}
                    >
                      <CheckCheck className="size-3" />
                      <span className="text-[10px]">Viewed</span>
                    </Button>
                  </div>
                );
              })()}

            {viewMode === "uncommitted" && (
              <ScrollArea className="flex-1 min-h-0">
                {diffLoading ? (
                  <DiffViewer diffFile={null} loading={true} diffViewMode={effectiveDiffViewMode} />
                ) : diffFiles.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                    {isUncommittedScope ? "No uncommitted changes" : "No changes in this scope"}
                  </div>
                ) : selectedFile ? (
                  <DiffViewer
                    diffFile={selectedFile}
                    loading={false}
                    diffViewMode={effectiveDiffViewMode}
                    hunkSelection={
                      isUncommittedScope && !stagedFiles.has(selectedFile.fileName)
                        ? stagedHunks.get(selectedFile.fileName)
                        : undefined
                    }
                    onHunkToggle={
                      isUncommittedScope && !stagedFiles.has(selectedFile.fileName)
                        ? (idx) => handleHunkToggle(selectedFile.fileName, idx)
                        : undefined
                    }
                  />
                ) : (
                  <DiffViewer
                    diffFile={null}
                    loading={false}
                    error={diffError ? String(diffError) : undefined}
                    diffViewMode={effectiveDiffViewMode}
                  />
                )}
              </ScrollArea>
            )}
          </div>
        </div>
      </DiffStateProvider>
    </div>
  );
}
