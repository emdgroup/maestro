import { useState, useMemo, useEffect } from "react";
import { X, AlignJustify, Columns2, List, FolderTree } from "lucide-react";
import { DiffModeEnum } from "@git-diff-view/react";
import { cn, parseDiffString, computeFileStats } from "@/lib";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { DiffViewer } from "@/components/execution/DiffViewer";
import { FileTree } from "@/components/execution/FileTree";
import { useWorktreeDiffQuery } from "@/services/worktree.service";
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

  const worktreeId = worktree?.id ?? null;

  const {
    data: diffString,
    isLoading: diffLoading,
    error: diffError,
  } = useWorktreeDiffQuery(worktreeId, DIFF_TARGET_HEAD);

  const diffFiles = useMemo(() => {
    if (!diffString) return [];
    return parseDiffString(diffString);
  }, [diffString]);

  const filteredDiffFiles = useMemo(() => {
    if (!fileSearch.trim()) return diffFiles;
    const q = fileSearch.toLowerCase();
    return diffFiles.filter((f) => f.fileName.toLowerCase().includes(q));
  }, [diffFiles, fileSearch]);

  const handleTreeFileSelect = (fileName: string) => {
    const idx = diffFiles.findIndex((f) => f.fileName === fileName);
    setSelectedFileIndex(idx >= 0 ? idx : null);
  };

  // When the selected worktree changes, clear the file selection and search immediately
  // so we don't briefly show the previous worktree's file header.
  useEffect(() => {
    setSelectedFileIndex(null);
    setFileSearch("");
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
      <div className="h-12 border-b border-border bg-muted/30 flex items-center justify-between px-4 gap-2 shrink-0">
        {/* Left side: worktree name + file search + flat/tree toggle */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-sm font-semibold truncate shrink-0 max-w-[200px]">
            {worktree.branch_name}
          </span>
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

        {/* Right side: unified/split toggle + close button */}
        <div className="flex items-center gap-2 shrink-0">
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
