import { useState, useMemo, useEffect } from "react";
import { X, AlignJustify, Columns2, List, FolderTree, Check, Minus } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { DiffModeEnum } from "@git-diff-view/react";
import { cn, parseDiffString, computeFileStats, extractHunkPatch, countHunks } from "@/lib";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { DiffViewer } from "@/components/execution/DiffViewer";
import { FileTree } from "@/components/execution/FileTree";
import {
  useWorktreeDiffQuery,
  useStageWorktreeFilesMutation,
  useCommitWorktreeMutation,
} from "@/services/worktree.service";
import type { WorktreeWithStatus, DiffTarget } from "@/types/bindings";

const DIFF_TARGET_HEAD: DiffTarget = { type: "Head" };

interface WorktreeDiffPanelProps {
  worktree: WorktreeWithStatus | null;
  onClose: () => void;
}

export function WorktreeDiffPanel({ worktree, onClose }: WorktreeDiffPanelProps) {
  const [diffViewMode, setDiffViewMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);
  const [selectedFileIndex, setSelectedFileIndex] = useState<number | null>(null);
  const [fileListMode, setFileListMode] = useState<"flat" | "tree">("flat");
  const [fileSearch, setFileSearch] = useState("");
  const [stagedFiles, setStagedFiles] = useState<Set<string>>(new Set());
  const [stagedHunks, setStagedHunks] = useState<Map<string, Set<number>>>(new Map());
  const [commitMessage, setCommitMessage] = useState("");

  const worktreeId = worktree?.id ?? null;

  const {
    data: diffString,
    isLoading: diffLoading,
    error: diffError,
  } = useWorktreeDiffQuery(worktreeId, DIFF_TARGET_HEAD);

  const stageMutation = useStageWorktreeFilesMutation();
  const commitMutation = useCommitWorktreeMutation();

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

  async function handleCommit() {
    if (!worktreeId || !commitMessage.trim()) return;

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
        worktreeId,
        filePaths: filesToStage,
        patch: combinedPatch,
      });
      await commitMutation.mutateAsync({
        worktreeId,
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

  // When the selected worktree changes, clear the file selection, search, and staging state
  // so we don't briefly show the previous worktree's file header.
  useEffect(() => {
    setSelectedFileIndex(null);
    setFileSearch("");
    setStagedFiles(new Set());
    setStagedHunks(new Map());
    setCommitMessage("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId]);

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
            <ToggleGroupItem value="flat" size="sm" variant="outline" className="h-8 w-8 p-0">
              <List className="h-3.5 w-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem value="tree" size="sm" variant="outline" className="h-8 w-8 p-0">
              <FolderTree className="h-3.5 w-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {/* Center: branch name — absolutely positioned to span the full bar */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="font-mono text-sm font-semibold truncate max-w-[300px]">
            {worktree.branch_name}
          </span>
        </div>

        {/* Right side: unified/split toggle + close button */}
        <div className="ml-auto flex items-center gap-2 z-10">
          <ToggleGroup
            value={[
              forceUnified || effectiveDiffViewMode !== DiffModeEnum.SplitGitHub
                ? "unified"
                : "split",
            ]}
            onValueChange={(values) => {
              if (forceUnified) return;
              if (values.includes("split")) {
                setDiffViewMode(DiffModeEnum.SplitGitHub);
              } else {
                setDiffViewMode(DiffModeEnum.Unified);
              }
            }}
          >
            <ToggleGroupItem value="unified" size="sm" variant="outline" className="h-8 w-8 p-0">
              <AlignJustify className="h-3.5 w-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="split"
              size="sm"
              variant="outline"
              disabled={forceUnified}
              className={cn("h-8 w-8 p-0", forceUnified && "opacity-30 cursor-not-allowed")}
            >
              <Columns2 className="h-3.5 w-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* File list + diff body split */}
      <div className="flex flex-1 min-h-0">
        {/* Left file list panel */}
        <div className="w-[200px] shrink-0 flex flex-col border-r border-border">
          <div className="flex-1 overflow-y-auto">
            {diffLoading ? (
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
                          className="border-border dark:bg-input/30 data-checked:bg-accent data-checked:text-foreground data-checked:border-foreground flex size-4 items-center justify-center rounded-[4px] border shadow-xs shrink-0 outline-none"
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

          {/* Commit area — visible only when files staged */}
          {hasAnyStaged && (
            <div className="border-t border-border p-2 shrink-0 flex flex-col gap-2">
              <Textarea
                placeholder="Commit message..."
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                className="text-xs min-h-[60px] resize-none"
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
          )}
        </div>

        {/* Right diff body */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Per-file header bar */}
          {selectedFile &&
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

          {/* Diff content */}
          <div className="flex-1 min-h-0 overflow-y-auto">
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
        </div>
      </div>
    </div>
  );
}
