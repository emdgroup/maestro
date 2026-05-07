import { useState, useMemo } from "react";
import { DiffModeEnum } from "@git-diff-view/react";
import { parseDiffString, computeFileStats, extractHunkPatch, countHunks } from "@/lib/diff-utils";
import { cn } from "@/lib/ui-utils";
import { DiffViewer } from "@/components/execution/DiffViewer";
import { DiffActionBar } from "@/components/execution/DiffActionBar";
import { DiffFilePanel } from "@/components/execution/DiffFilePanel";
import { useStagingState } from "@/components/execution/useStagingState";
import {
  useWorktreeDiffQuery,
  useStageWorktreeFilesMutation,
  useCommitWorktreeMutation,
  useDiscardWorktreeChangesMutation,
  useShelveWorktreeChangesMutation,
  useDeleteUntrackedFilesMutation,
} from "@/services/worktree.service";
import type { WorktreeWithStatus, DiffTarget } from "@/types/bindings";

const DIFF_TARGET_HEAD: DiffTarget = { type: "Head" };

interface WorktreeDiffPanelProps {
  worktree: WorktreeWithStatus | null;
  projectId: number | null;
  onClose: () => void;
}

export function WorktreeDiffPanel({ worktree, projectId, onClose }: WorktreeDiffPanelProps) {
  const [diffViewMode, setDiffViewMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);
  const [viewMode, setViewMode] = useState<"uncommitted" | "untracked">("uncommitted");
  const [fileListMode, setFileListMode] = useState<"flat" | "tree">("flat");

  const worktreePath = worktree?.path ?? null;

  const {
    data: diffResult,
    isLoading: diffLoading,
    error: diffError,
  } = useWorktreeDiffQuery(projectId, worktreePath, DIFF_TARGET_HEAD);

  const diffString = diffResult?.diff ?? null;
  const untrackedFiles = diffResult?.untracked_files ?? [];

  const stageMutation = useStageWorktreeFilesMutation();
  const commitMutation = useCommitWorktreeMutation();
  const discardMutation = useDiscardWorktreeChangesMutation();
  const shelveMutation = useShelveWorktreeChangesMutation();
  const deleteMutation = useDeleteUntrackedFilesMutation();
  const [shelvePopoverOpen, setShelvePopoverOpen] = useState(false);

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

  async function handleRevert() {
    if (!projectId || !worktreePath) return;

    const filePathsToRevert = [...stagedFiles];

    const patchParts: string[] = [];
    for (const [fileName, hunkIndices] of stagedHunks) {
      if (stagedFiles.has(fileName)) continue;
      const file = diffFiles.find((f) => f.fileName === fileName);
      if (!file) continue;
      for (const idx of hunkIndices) {
        const patch = extractHunkPatch(file.hunks[0] ?? "", idx);
        if (patch) patchParts.push(patch);
      }
    }
    const combinedPatch = patchParts.length > 0 ? patchParts.join("") : null;

    try {
      await discardMutation.mutateAsync({
        projectId,
        worktreePath,
        filePaths: filePathsToRevert,
        patch: combinedPatch,
      });
      setStagedFiles(new Set());
      setStagedHunks(new Map());
    } catch {
      // error toast handled by mutation
    }
  }

  async function handleShelve() {
    if (!projectId || !worktreePath || !shelveName.trim()) return;

    const filePaths = [
      ...stagedFiles,
      ...[...stagedHunks.keys()].filter((f) => !stagedFiles.has(f)),
    ];

    try {
      await shelveMutation.mutateAsync({
        projectId,
        worktreePath,
        stashName: shelveName.trim(),
        filePaths,
      });
      setStagedFiles(new Set());
      setStagedHunks(new Map());
      setShelvePopoverOpen(false);
    } catch {
      // error toast handled by mutation
    }
  }

  async function handleCommit() {
    if (!projectId || !worktreePath || !commitMessage.trim()) return;

    const filesToStage = [...stagedFiles];
    const patchParts: string[] = [];
    for (const [fileName, hunkIndices] of stagedHunks) {
      if (stagedFiles.has(fileName)) continue;
      const file = diffFiles.find((f) => f.fileName === fileName);
      if (!file) continue;
      for (const idx of hunkIndices) {
        const patch = extractHunkPatch(file.hunks[0] ?? "", idx);
        if (patch) patchParts.push(patch);
      }
    }
    const combinedPatch = patchParts.length > 0 ? patchParts.join("") : null;

    try {
      await stageMutation.mutateAsync({
        projectId,
        worktreePath,
        filePaths: filesToStage,
        patch: combinedPatch,
      });
      await commitMutation.mutateAsync({
        projectId,
        worktreePath,
        message: commitMessage.trim(),
      });

      setStagedFiles(new Set());
      setStagedHunks(new Map());
      setCommitMessage("");

      const allFilesStaged = filesToStage.length === diffFiles.length && !combinedPatch;
      if (allFilesStaged) {
        onClose();
      }
    } catch {
      // errors handled by mutation onError toasts
    }
  }

  async function handleStageUntracked() {
    if (!projectId || !worktreePath) return;
    try {
      await stageMutation.mutateAsync({
        projectId,
        worktreePath,
        filePaths: [...stagedFiles],
        patch: null,
      });
      setStagedFiles(new Set());
    } catch {
      // error toast handled by mutation
    }
  }

  async function handleDeleteUntracked() {
    if (!projectId || !worktreePath || stagedFiles.size === 0) return;
    try {
      await deleteMutation.mutateAsync({
        projectId,
        worktreePath,
        filePaths: [...stagedFiles],
      });
      setStagedFiles(new Set());
    } catch {
      // error toast handled by mutation
    }
  }

  function handleToggleUntrackedFile(filePath: string) {
    setStagedFiles((prev) => {
      const n = new Set(prev);
      if (n.has(filePath)) n.delete(filePath);
      else n.add(filePath);
      return n;
    });
  }

  const handleTreeFileSelect = (fileName: string) => {
    const idx = diffFiles.findIndex((f) => f.fileName === fileName);
    setSelectedFileIndex(idx >= 0 ? idx : null);
  };

  const selectedFile = selectedFileIndex !== null ? (diffFiles[selectedFileIndex] ?? null) : null;
  const forceUnified = selectedFile?.status === "A" || selectedFile?.status === "D";
  const effectiveDiffViewMode = forceUnified ? DiffModeEnum.Unified : diffViewMode;

  if (worktree === null) {
    return null;
  }

  return (
    <div className="flex flex-col h-full">
      <DiffActionBar
        branchName={worktree.branch_name}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        fileSearch={fileSearch}
        onFileSearchChange={setFileSearch}
        fileListMode={fileListMode}
        onFileListModeChange={setFileListMode}
        diffViewMode={diffViewMode}
        onDiffViewModeChange={setDiffViewMode}
        forceUnified={forceUnified}
        hasAnyStaged={hasAnyStaged}
        isDiscarding={discardMutation.isPending}
        isDeletingUntracked={deleteMutation.isPending}
        isShelving={shelveMutation.isPending}
        shelvePopoverOpen={shelvePopoverOpen}
        onShelvePopoverOpenChange={setShelvePopoverOpen}
        shelveName={shelveName}
        onShelveNameChange={setShelveName}
        onRevert={viewMode === "untracked" ? handleDeleteUntracked : handleRevert}
        onShelve={handleShelve}
        onClose={onClose}
      />

      <div className="flex flex-1 min-h-0">
        <DiffFilePanel
          viewMode={viewMode}
          fileListMode={fileListMode}
          diffLoading={diffLoading}
          diffFiles={diffFiles}
          filteredDiffFiles={filteredDiffFiles}
          untrackedFiles={untrackedFiles}
          selectedFileIndex={selectedFileIndex}
          onFileIndexChange={setSelectedFileIndex}
          stagedFiles={stagedFiles}
          getFileCheckState={getFileCheckState}
          onFileToggle={handleFileToggle}
          onFolderToggle={handleFolderToggle}
          onToggleUntrackedFile={handleToggleUntrackedFile}
          onTreeFileSelect={handleTreeFileSelect}
          hasAnyStaged={hasAnyStaged}
          commitMessage={commitMessage}
          onCommitMessageChange={setCommitMessage}
          onCommit={handleCommit}
          isCommitting={commitMutation.isPending}
          isStaging={stageMutation.isPending}
          onStageUntracked={handleStageUntracked}
        />

        {/* Right diff body */}
        <div className="flex-1 flex flex-col min-w-0">
          {viewMode === "untracked" && (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              {selectedFileIndex !== null && untrackedFiles[selectedFileIndex]
                ? untrackedFiles[selectedFileIndex]
                : "Select a file to view its path"}
            </div>
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
              return (
                <div className="px-3 py-2 border-b border-border bg-muted/20 shrink-0 flex items-center gap-2 text-xs">
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
                </div>
              );
            })()}

          {viewMode === "uncommitted" && (
            <div className="flex-1 min-h-0 overflow-auto">
              {diffLoading ? (
                <DiffViewer diffFile={null} loading={true} diffViewMode={effectiveDiffViewMode} />
              ) : worktree.git_status === "" && diffFiles.length === 0 ? (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                  No uncommitted changes
                </div>
              ) : selectedFile ? (
                <DiffViewer
                  diffFile={selectedFile}
                  loading={false}
                  diffViewMode={effectiveDiffViewMode}
                  hunkSelection={
                    stagedFiles.has(selectedFile.fileName)
                      ? undefined
                      : stagedHunks.get(selectedFile.fileName)
                  }
                  onHunkToggle={
                    stagedFiles.has(selectedFile.fileName)
                      ? undefined
                      : (idx) => handleHunkToggle(selectedFile.fileName, idx)
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
