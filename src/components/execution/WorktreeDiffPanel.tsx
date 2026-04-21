import { useState, useMemo, useEffect } from "react";
import { X, AlignJustify, Columns2, List, FolderTree, Check, Minus, RotateCcw, Archive } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { DiffModeEnum } from "@git-diff-view/react";
import { cn, parseDiffString, computeFileStats, extractHunkPatch, countHunks } from "@/lib";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/ui/alert-dialog";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/ui/select";
import { DiffViewer } from "@/components/execution/DiffViewer";
import { FileTree } from "@/components/execution/FileTree";
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
  const [selectedFileIndex, setSelectedFileIndex] = useState<number | null>(null);
  const [fileListMode, setFileListMode] = useState<"flat" | "tree">("flat");
  const [fileSearch, setFileSearch] = useState("");
  const [stagedFiles, setStagedFiles] = useState<Set<string>>(new Set());
  const [stagedHunks, setStagedHunks] = useState<Map<string, Set<number>>>(new Map());
  const [commitMessage, setCommitMessage] = useState("");

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

  const defaultShelveName = worktree
    ? `wip-${worktree.branch_name.replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-")}-${new Date().toISOString().split("T")[0]}`
    : "";
  const [shelveName, setShelveName] = useState(defaultShelveName);

  const diffFiles = useMemo(() => {
    if (!diffString) return [];
    return parseDiffString(diffString);
  }, [diffString]);

  const filteredDiffFiles = useMemo(() => {
    if (!fileSearch.trim()) return diffFiles;
    const q = fileSearch.toLowerCase();
    return diffFiles.filter((f) => f.fileName.toLowerCase().includes(q));
  }, [diffFiles, fileSearch]);

  const hasAnyStaged =
    stagedFiles.size > 0 || [...stagedHunks.values()].some((s) => s.size > 0);

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
      // Uncheck: remove from stagedFiles AND stagedHunks
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
      // Check: add to stagedFiles (full file), clear hunk-level selection
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
      // Uncheck all: remove from stagedFiles and stagedHunks
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
      // Check all: add to stagedFiles, clear per-file hunk selections
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

    // Stage files first
    const filesToStage = [...stagedFiles];
    // Build patch for hunk-level staged items
    const patchParts: string[] = [];
    for (const [fileName, hunkIndices] of stagedHunks) {
      if (stagedFiles.has(fileName)) continue; // whole file already staged
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

      // Clear state after successful commit
      setStagedFiles(new Set());
      setStagedHunks(new Map());
      setCommitMessage("");

      // Check if all files were staged (no remaining changes)
      const allFilesStaged = filesToStage.length === diffFiles.length && !combinedPatch;
      if (allFilesStaged) {
        onClose(); // close diff panel — no remaining changes
      }
    } catch {
      // errors handled by mutation onError toasts
    }
  }

  const handleTreeFileSelect = (fileName: string) => {
    const idx = diffFiles.findIndex((f) => f.fileName === fileName);
    setSelectedFileIndex(idx >= 0 ? idx : null);
  };

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

  // When the selected worktree changes, clear the file selection, search, and staging state
  // so we don't briefly show the previous worktree's file header.
  useEffect(() => {
    setSelectedFileIndex(null);
    setFileSearch("");
    setStagedFiles(new Set());
    setStagedHunks(new Map());
    setCommitMessage("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreePath]);

  // Clear staging state when switching between uncommitted/untracked modes
  useEffect(() => {
    setStagedFiles(new Set());
    setStagedHunks(new Map());
    setSelectedFileIndex(null);
    setCommitMessage("");
  }, [viewMode]);

  // Update auto-generated shelve name when worktree changes
  useEffect(() => {
    if (worktree) {
      setShelveName(
        `wip-${worktree.branch_name.replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-")}-${new Date().toISOString().split("T")[0]}`,
      );
    }
  }, [worktree]);

  // Auto-select the first file once diff data loads for the current worktree.
  // Only fires when selectedFileIndex is null (i.e. we haven't picked one yet),
  // so a background refetch does not bounce the user back to file 0 mid-navigation.
  useEffect(() => {
    if (diffFiles.length > 0) {
      setSelectedFileIndex((prev) => (prev === null ? 0 : prev));
    }
  }, [diffFiles]);

  const selectedFile = selectedFileIndex !== null ? (diffFiles[selectedFileIndex] ?? null) : null;
  const forceUnified = selectedFile?.status === "A" || selectedFile?.status === "D";
  const effectiveDiffViewMode = forceUnified ? DiffModeEnum.Unified : diffViewMode;

  // When worktree is null, render nothing — component is mounted for slide animation
  if (worktree === null) {
    return null;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="relative h-12 border-b border-border bg-muted/30 flex items-center px-4 shrink-0">
        {/* Left side: file search + flat/tree toggle */}
        <div className="flex items-center gap-2 z-10">
          <Input
            placeholder="Filter files..."
            value={fileSearch}
            onChange={(e) => setFileSearch(e.target.value)}
            className="h-8 w-48 text-xs"
          />
          <ToggleGroup
            value={[fileListMode]}
            onValueChange={(values) => {
              if (values.includes("tree")) setFileListMode("tree");
              else setFileListMode("flat");
            }}
          >
            <ToggleGroupItem value="flat" size="sm" variant="outline" className="size-8 p-0">
              <List className="size-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem value="tree" size="sm" variant="outline" className="size-8 p-0">
              <FolderTree className="size-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>

          {/* Revert button with confirmation dialog */}
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    viewMode === "untracked"
                      ? stagedFiles.size === 0 || deleteMutation.isPending
                      : !hasAnyStaged || discardMutation.isPending
                  }
                  className="h-8 w-8 p-0"
                  title={viewMode === "untracked" ? "Delete selected files" : "Revert selected changes"}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {viewMode === "untracked" ? "Delete files?" : "Discard changes?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {viewMode === "untracked"
                    ? "This will permanently delete the selected untracked files. This action cannot be undone."
                    : "This will permanently discard the selected changes. This action cannot be undone."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={viewMode === "untracked" ? handleDeleteUntracked : handleRevert}
                >
                  {viewMode === "untracked" ? "Delete" : "Discard"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* Shelve button with name popover */}
          <Popover open={shelvePopoverOpen} onOpenChange={(open) => setShelvePopoverOpen(open)}>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!hasAnyStaged || shelveMutation.isPending || viewMode === "untracked"}
                  className="h-8 w-8 p-0"
                  title="Shelve selected changes"
                >
                  <Archive className="h-3.5 w-3.5" />
                </Button>
              }
            />
            <PopoverContent className="w-64 p-3">
              <div className="flex flex-col gap-2">
                <label className="text-xs font-medium">Stash name</label>
                <Input
                  value={shelveName}
                  onChange={(e) => setShelveName(e.target.value)}
                  className="h-8 text-xs"
                  placeholder="wip-branch-name-2026-04-02"
                />
                <Button
                  size="sm"
                  className="w-full"
                  disabled={!shelveName.trim() || shelveMutation.isPending}
                  onClick={handleShelve}
                >
                  {shelveMutation.isPending ? "Shelving..." : "Confirm"}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>

        {/* Center: view mode dropdown — absolutely positioned to span the full bar */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-1.5 font-mono text-sm font-semibold">
            <span className="truncate max-w-48">{worktree.branch_name}</span>
            <span>-</span>
            <Select value={viewMode} onValueChange={(v) => setViewMode(v as "uncommitted" | "untracked")}>
              <SelectTrigger size="sm" className="h-auto border-none shadow-none bg-transparent font-mono text-sm font-semibold p-0 gap-1 focus:ring-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="uncommitted">Uncommitted Changes</SelectItem>
                <SelectItem value="untracked">Untracked Changes</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Right side: unified/split toggle + close button */}
        <div className="ml-auto flex items-center gap-2 z-10">
          <ToggleGroup
            value={[
              forceUnified || viewMode === "untracked" || effectiveDiffViewMode !== DiffModeEnum.SplitGitHub
                ? "unified"
                : "split",
            ]}
            onValueChange={(values) => {
              if (forceUnified || viewMode === "untracked") return;
              if (values.includes("split")) {
                setDiffViewMode(DiffModeEnum.SplitGitHub);
              } else {
                setDiffViewMode(DiffModeEnum.Unified);
              }
            }}
          >
            <ToggleGroupItem value="unified" size="sm" variant="outline" className="size-8 p-0">
              <AlignJustify className="size-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="split"
              size="sm"
              variant="outline"
              disabled={forceUnified || viewMode === "untracked"}
              className={cn("size-8 p-0", (forceUnified || viewMode === "untracked") && "opacity-30 cursor-not-allowed")}
            >
              <Columns2 className="size-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* File list + diff body split */}
      <div className="flex flex-1 min-h-0">
        {/* Left file list panel */}
        <div className="w-64 shrink-0 flex flex-col border-r border-border">
          <div className="flex-1 overflow-y-auto">
            {viewMode === "untracked" ? (
              diffLoading ? (
                <div className="text-xs text-muted-foreground py-8 text-center">Loading...</div>
              ) : untrackedFiles.length === 0 ? (
                <div className="text-xs text-muted-foreground py-8 text-center">No untracked files</div>
              ) : (
                untrackedFiles.map((filePath, index) => {
                  const basename = filePath.split("/").pop() ?? filePath;
                  const isChecked = stagedFiles.has(filePath);
                  return (
                    <div
                      key={filePath}
                      onClick={() => setSelectedFileIndex(index)}
                      className={cn(
                        "px-2 py-2 cursor-pointer border-l-2 transition-colors",
                        index === selectedFileIndex
                          ? "border-ring bg-muted/20"
                          : "border-transparent hover:bg-muted/10",
                      )}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            setStagedFiles((prev) => {
                              const n = new Set(prev);
                              if (n.has(filePath)) n.delete(filePath);
                              else n.add(filePath);
                              return n;
                            });
                          }}
                          className="shrink-0"
                        >
                          <CheckboxPrimitive.Root
                            checked={isChecked}
                            className="border-border dark:bg-input/30 data-checked:bg-accent data-checked:text-foreground data-checked:border-foreground flex size-4 items-center justify-center rounded-sm border shadow-xs shrink-0 outline-none"
                            tabIndex={-1}
                          >
                            <CheckboxPrimitive.Indicator className="[&>svg]:size-3.5 grid place-content-center text-current">
                              <Check className="size-3.5" />
                            </CheckboxPrimitive.Indicator>
                          </CheckboxPrimitive.Root>
                        </span>
                        <span className="text-xs font-medium shrink-0 text-success">?</span>
                        <span className="text-xs font-mono truncate flex-1 min-w-0">{basename}</span>
                      </div>
                    </div>
                  );
                })
              )
            ) : diffLoading ? (
              <div className="text-xs text-muted-foreground py-8 text-center">Loading...</div>
            ) : diffFiles.length === 0 ? (
              <div className="text-xs text-muted-foreground py-8 text-center" />
            ) : fileListMode === "tree" ? (
              <FileTree
                files={filteredDiffFiles}
                selectedFile={selectedFile?.fileName ?? null}
                onSelectFile={handleTreeFileSelect}
                checkedFiles={
                  new Map(filteredDiffFiles.map((f) => [f.fileName, getFileCheckState(f.fileName)]))
                }
                onToggleFile={handleFileToggle}
                onToggleFolder={handleFolderToggle}
              />
            ) : (
              filteredDiffFiles.map((file) => {
                const realIndex = diffFiles.findIndex((f) => f.fileName === file.fileName);
                const basename = file.fileName.split("/").pop() ?? file.fileName;
                const status = file.status ?? "M";
                const statusColor =
                  status === "A"
                    ? "text-success"
                    : status === "D"
                      ? "text-destructive"
                      : "text-muted-foreground";
                const checkState = getFileCheckState(file.fileName);
                return (
                  <div
                    key={file.fileName}
                    onClick={() => setSelectedFileIndex(realIndex)}
                    className={cn(
                      "px-2 py-2 cursor-pointer border-l-2 transition-colors",
                      realIndex === selectedFileIndex
                        ? "border-ring bg-muted/20"
                        : "border-transparent hover:bg-muted/10",
                    )}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          handleFileToggle(file.fileName);
                        }}
                        className="shrink-0"
                      >
                        <CheckboxPrimitive.Root
                          checked={checkState === "checked"}
                          indeterminate={checkState === "indeterminate"}
                          className="border-border dark:bg-input/30 data-checked:bg-accent data-checked:text-foreground data-checked:border-foreground flex size-4 items-center justify-center rounded-sm border shadow-xs shrink-0 outline-none"
                          tabIndex={-1}
                        >
                          <CheckboxPrimitive.Indicator className="[&>svg]:size-3.5 grid place-content-center text-current">
                            {checkState === "indeterminate" ? (
                              <Minus className="size-3.5" />
                            ) : (
                              <Check className="size-3.5" />
                            )}
                          </CheckboxPrimitive.Indicator>
                        </CheckboxPrimitive.Root>
                      </span>
                      <span className={cn("text-xs font-medium shrink-0", statusColor)}>
                        {status}
                      </span>
                      <span className="text-xs font-mono truncate flex-1 min-w-0">{basename}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Bottom action area */}
          {viewMode === "untracked" ? (
            stagedFiles.size > 0 && (
              <div className="border-t border-border p-2 shrink-0">
                <Button
                  size="sm"
                  className="w-full"
                  disabled={stageMutation.isPending}
                  onClick={async () => {
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
                  }}
                >
                  {stageMutation.isPending ? "Staging..." : "Stage Selected"}
                </Button>
              </div>
            )
          ) : (
            /* Commit area — visible only when files staged */
            hasAnyStaged && (
              <div className="border-t border-border p-2 shrink-0 flex flex-col gap-2">
                <Textarea
                  placeholder="Commit message..."
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  className="text-xs min-h-15 resize-none"
                  rows={3}
                />
                <Button
                  size="sm"
                  className="w-full"
                  disabled={
                    !commitMessage.trim() || commitMutation.isPending || stageMutation.isPending
                  }
                  onClick={handleCommit}
                >
                  {commitMutation.isPending || stageMutation.isPending ? "Committing..." : "Commit"}
                </Button>
              </div>
            )
          )}
        </div>

        {/* Right diff body */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Untracked mode: show selected file path or placeholder */}
          {viewMode === "untracked" && (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              {selectedFileIndex !== null && untrackedFiles[selectedFileIndex]
                ? untrackedFiles[selectedFileIndex]
                : "Select a file to view its path"}
            </div>
          )}

          {/* Per-file header bar (uncommitted mode only) */}
          {viewMode === "uncommitted" && selectedFile &&
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

          {/* Diff content (uncommitted mode only) */}
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
