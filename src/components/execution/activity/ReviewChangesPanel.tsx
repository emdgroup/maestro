import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { X, AlignJustify, Columns2, List, FolderTree, FileDiff, CheckCheck } from "lucide-react";
import { DiffModeEnum } from "@git-diff-view/react";
import { cn } from "@/lib/ui-utils";
import { Input } from "@/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { DiffViewer } from "@/components/execution/diff/DiffViewer";
import { FileTree } from "@/components/execution/diff/FileTree";
import { parseDiffString, computeFileStats } from "@/lib/diff-utils";
import { useWorktreeDiffQuery } from "@/services/worktree.service";
import { UntrackedFileDiffViewer } from "@/components/execution/diff/UntrackedFileDiffViewer";
import { api } from "@/lib/tauri-utils";
import type { DiffFileWithName } from "@/types/review";

type DisplayItem = { kind: "diff"; file: DiffFileWithName } | { kind: "untracked"; path: string };

interface ReviewChangesPanelProps {
  sessionKey: number;
  sessionChangedFiles: string[];
  onClose: () => void;
  initialFile?: string;
}

export function ReviewChangesPanel({
  sessionKey,
  sessionChangedFiles,
  onClose,
  initialFile,
}: ReviewChangesPanelProps) {
  const [diffViewMode, setDiffViewMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);
  const [fileListMode, setFileListMode] = useState<"flat" | "tree">("flat");
  const [search, setSearch] = useState("");
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());
  const initialFileAppliedRef = useRef(false);

  const toggleViewed = useCallback((fileName: string) => {
    setViewedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });
  }, []);

  const [projectId, setProjectId] = useState<number | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [startSha, setStartSha] = useState<string | null>(null);
  const [metaError, setMetaError] = useState(false);

  useEffect(() => {
    api
      .getAcpSessionMeta(sessionKey)
      .then((meta) => {
        setProjectId(meta.project_id ?? null);
        setCwd(meta.cwd);
        setStartSha(meta.session_start_sha ?? null);
      })
      .catch(() => {
        setMetaError(true);
      });
  }, [sessionKey]);

  const diffTarget = useMemo(
    () =>
      startSha ? ({ type: "Commit", sha: startSha } as const) : ({ type: "Head" } as const),
    [startSha],
  );

  const {
    data: diffResult,
    isLoading: diffLoading,
    error: diffError,
  } = useWorktreeDiffQuery(projectId, cwd, diffTarget);

  // Normalize agent tool-call paths (may be absolute) to repo-relative for matching
  const changedRelativePaths = useMemo(() => {
    const set = new Set<string>();
    for (const path of sessionChangedFiles) {
      if (cwd && path.startsWith(cwd + "/")) {
        set.add(path.slice(cwd.length + 1));
      } else {
        set.add(path);
      }
    }
    return set;
  }, [sessionChangedFiles, cwd]);

  const diffFiles = useMemo(() => {
    if (!diffResult?.diff) return [];
    const all = parseDiffString(diffResult.diff);
    if (changedRelativePaths.size === 0) return all;
    return all.filter((f) => changedRelativePaths.has(f.fileName));
  }, [diffResult?.diff, changedRelativePaths]);

  const untrackedFiles = useMemo(() => {
    const all = diffResult?.untracked_files ?? [];
    if (changedRelativePaths.size === 0) return all;
    return all.filter((p) => changedRelativePaths.has(p));
  }, [diffResult?.untracked_files, changedRelativePaths]);

  const allDisplayItems = useMemo<DisplayItem[]>(() => {
    return [
      ...diffFiles.map((file): DisplayItem => ({ kind: "diff", file })),
      ...untrackedFiles.map((path): DisplayItem => ({ kind: "untracked", path })),
    ];
  }, [diffFiles, untrackedFiles]);

  useEffect(() => {
    if (!initialFile || initialFileAppliedRef.current || allDisplayItems.length === 0) return;
    // diff items have relative fileName; initialFile is absolute → check absolute ends with relative.
    // untracked items have absolute path → check absolute path ends with initialFile (handles bare filename too).
    const idx = allDisplayItems.findIndex((item) =>
      item.kind === "diff"
        ? initialFile.endsWith(item.file.fileName)
        : item.path.endsWith(initialFile),
    );
    if (idx >= 0) {
      setSelectedFileIndex(idx);
      initialFileAppliedRef.current = true;
    }
  }, [allDisplayItems, initialFile]);

  const filteredItems = useMemo(() => {
    if (!search.trim()) return allDisplayItems;
    const lower = search.toLowerCase();
    return allDisplayItems.filter((item) =>
      (item.kind === "diff" ? item.file.fileName : item.path).toLowerCase().includes(lower),
    );
  }, [allDisplayItems, search]);

  const selectedItem: DisplayItem | null = filteredItems[selectedFileIndex] ?? null;

  const selectedUntrackedPath = selectedItem?.kind === "untracked" ? selectedItem.path : null;

  const totalStats = useMemo(() => {
    let insertions = 0;
    let deletions = 0;
    for (const f of diffFiles) {
      const stats = computeFileStats(f.hunks);
      insertions += stats.insertions;
      deletions += stats.deletions;
    }
    return { insertions, deletions };
  }, [diffFiles]);

  const loading = diffLoading || (projectId === null && cwd === null && !metaError);
  const totalFileCount = diffFiles.length + untrackedFiles.length;

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
      {/* Action bar */}
      <div className="flex items-center h-12 px-3 border-b border-border bg-card/50 shrink-0 gap-2">
        <FileDiff className="w-4 h-4 text-muted-foreground shrink-0" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter files..."
          className="h-7 w-36 text-xs"
        />
        <div className="w-px h-4 bg-border shrink-0" />
        <ToggleGroup
          value={[fileListMode]}
          onValueChange={(values) => {
            const v = values[values.length - 1];
            if (v === "flat" || v === "tree") setFileListMode(v);
          }}
        >
          <ToggleGroupItem value="flat" size="sm" variant="outline" className="size-7 p-0">
            <List className="size-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem value="tree" size="sm" variant="outline" className="size-7 p-0">
            <FolderTree className="size-3.5" />
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="flex-1" />
        <ToggleGroup
          value={[diffViewMode === DiffModeEnum.Unified ? "unified" : "split"]}
          onValueChange={(values) => {
            if (values.includes("split")) setDiffViewMode(DiffModeEnum.SplitGitHub);
            else setDiffViewMode(DiffModeEnum.Unified);
          }}
        >
          <ToggleGroupItem value="unified" size="sm" variant="outline" className="size-7 p-0">
            <AlignJustify className="size-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem value="split" size="sm" variant="outline" className="size-7 p-0">
            <Columns2 className="size-3.5" />
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="w-px h-4 bg-border shrink-0" />
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* File list */}
        <div className="w-64 shrink-0 border-r border-border flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {loading && (
              <div className="text-xs text-muted-foreground py-8 text-center animate-pulse">
                Loading...
              </div>
            )}
            {!loading && totalFileCount === 0 && !diffError && (
              <div className="text-xs text-muted-foreground py-8 text-center">No changes yet</div>
            )}
            {!loading && fileListMode === "tree" ? (
              <FileTree
                files={filteredItems.map((i) =>
                  i.kind === "diff"
                    ? i.file
                    : { fileName: i.path, hunks: [], status: "A" as const },
                )}
                selectedFile={
                  selectedItem?.kind === "diff"
                    ? selectedItem.file.fileName
                    : selectedItem?.kind === "untracked"
                      ? selectedItem.path
                      : null
                }
                onSelectFile={(fileName) => {
                  const idx = filteredItems.findIndex((i) =>
                    i.kind === "diff" ? i.file.fileName === fileName : i.path === fileName,
                  );
                  if (idx >= 0) setSelectedFileIndex(idx);
                }}
                viewedFiles={viewedFiles}
              />
            ) : (
              filteredItems.map((item, index) => {
                if (item.kind === "diff") {
                  const { file } = item;
                  const basename = file.fileName.split("/").pop() ?? file.fileName;
                  const stats = computeFileStats(file.hunks);
                  return (
                    <button
                      key={file.fileName}
                      type="button"
                      onClick={() => setSelectedFileIndex(index)}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-2 text-left border-l-2 transition-colors",
                        index === selectedFileIndex
                          ? "border-ring selected-file-item"
                          : "border-transparent hover:bg-muted/10",
                      )}
                    >
                      <span
                        className={cn(
                          "w-1.5 h-1.5 rounded-full shrink-0",
                          file.status === "A"
                            ? "bg-success"
                            : file.status === "D"
                              ? "bg-destructive"
                              : "bg-warning",
                        )}
                      />
                      <span className="flex-1 text-xs truncate text-foreground/80">{basename}</span>
                      {stats.insertions > 0 && (
                        <span className="text-[10px] text-success shrink-0">
                          +{stats.insertions}
                        </span>
                      )}
                      {stats.deletions > 0 && (
                        <span className="text-[10px] text-destructive shrink-0">
                          -{stats.deletions}
                        </span>
                      )}
                      {viewedFiles.has(file.fileName) && (
                        <CheckCheck className="size-3.5 shrink-0 text-success" />
                      )}
                    </button>
                  );
                } else {
                  const basename = item.path.split("/").pop() ?? item.path;
                  return (
                    <button
                      key={item.path}
                      type="button"
                      onClick={() => setSelectedFileIndex(index)}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-2 text-left border-l-2 transition-colors",
                        index === selectedFileIndex
                          ? "border-ring selected-file-item"
                          : "border-transparent hover:bg-muted/10",
                      )}
                    >
                      <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-success" />
                      <span className="flex-1 text-xs truncate text-foreground/80">{basename}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0">new</span>
                      {viewedFiles.has(item.path) && (
                        <CheckCheck className="size-3.5 shrink-0 text-success" />
                      )}
                    </button>
                  );
                }
              })
            )}
          </div>
          {/* Stats footer */}
          {totalFileCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 border-t border-border text-[10px] text-muted-foreground shrink-0">
              <span>
                {totalFileCount} {totalFileCount === 1 ? "file" : "files"}
              </span>
              {totalStats.insertions > 0 && (
                <span className="text-success">+{totalStats.insertions}</span>
              )}
              {totalStats.deletions > 0 && (
                <span className="text-destructive">-{totalStats.deletions}</span>
              )}
            </div>
          )}
        </div>

        {/* Diff viewer */}
        <div className="flex-1 min-h-0 min-w-0 flex flex-col">
          {/* File content header */}
          {selectedItem && (() => {
            const fileName = selectedItem.kind === "diff" ? selectedItem.file.fileName : selectedItem.path;
            const status = selectedItem.kind === "diff" ? (selectedItem.file.status ?? "M") : "A";
            const stats = selectedItem.kind === "diff" ? computeFileStats(selectedItem.file.hunks) : { insertions: 0, deletions: 0 };
            const statusColor = status === "A" ? "text-success" : status === "D" ? "text-destructive" : "text-muted-foreground";
            const isViewed = viewedFiles.has(fileName);
            return (
              <div className="px-3 py-1.5 border-b border-border bg-muted/20 shrink-0 flex items-center gap-2 text-xs">
                <span className="font-mono text-foreground truncate flex-1">{fileName}</span>
                <span className={cn("font-medium shrink-0", statusColor)}>{status}</span>
                {stats.insertions > 0 && <span className="text-success shrink-0">+{stats.insertions}</span>}
                {stats.deletions > 0 && <span className="text-destructive shrink-0">-{stats.deletions}</span>}
                <button
                  onClick={() => toggleViewed(fileName)}
                  className={cn(
                    "flex items-center gap-1 px-1.5 py-0.5 rounded border border-border hover:bg-muted/30",
                    isViewed ? "text-success" : "text-muted-foreground hover:text-foreground",
                  )}
                  title={isViewed ? "Mark as unviewed" : "Mark as viewed"}
                >
                  <CheckCheck className="size-3" />
                  <span className="text-[10px]">Viewed</span>
                </button>
              </div>
            );
          })()}

          {loading ? (
            <div className="flex-1 min-h-0 overflow-auto custom-scrollbar">
              <DiffViewer diffFile={null} loading={true} diffViewMode={diffViewMode} />
            </div>
          ) : selectedItem?.kind === "diff" ? (
            <div className="flex-1 min-h-0 overflow-auto custom-scrollbar">
              <DiffViewer
                diffFile={selectedItem.file}
                loading={false}
                diffViewMode={diffViewMode}
              />
            </div>
          ) : selectedItem?.kind === "untracked" ? (
            <UntrackedFileDiffViewer
              projectId={projectId}
              worktreePath={cwd}
              filePath={selectedUntrackedPath}
              showHeader={false}
            />
          ) : (
            <div className="flex-1 min-h-0 overflow-auto custom-scrollbar">
              <DiffViewer
                diffFile={null}
                loading={false}
                error={diffError ? String(diffError) : undefined}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
