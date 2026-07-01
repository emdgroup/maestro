import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  X,
  AlignJustify,
  Columns2,
  List,
  FolderTree,
  FileDiff,
  CheckCheck,
  ChevronRight,
  ListCollapse,
  ChevronLeft,
} from "lucide-react";
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
  compact?: boolean;
}

export function ReviewChangesPanel({
  sessionKey,
  sessionChangedFiles,
  onClose,
  initialFile,
  compact = false,
}: ReviewChangesPanelProps) {
  const [diffViewMode, setDiffViewMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);
  const [fileListMode, setFileListMode] = useState<"flat" | "tree">("flat");
  const [search, setSearch] = useState("");
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());
  const [listOpen, setListOpen] = useState(false);
  const [listSearch, setListSearch] = useState("");
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const initialFileAppliedRef = useRef(false);
  const expandedInitRef = useRef(false);
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const programmaticScrollRef = useRef(false);

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
    () => (startSha ? ({ type: "Commit", sha: startSha } as const) : ({ type: "Head" } as const)),
    [startSha],
  );

  const {
    data: diffResult,
    isLoading: diffLoading,
    error: diffError,
  } = useWorktreeDiffQuery(projectId, cwd, diffTarget);

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

  // Auto-expand all files in compact mode (once on first load)
  useEffect(() => {
    if (!compact || allDisplayItems.length === 0 || expandedInitRef.current) return;
    expandedInitRef.current = true;
    setExpandedFiles(
      new Set(
        allDisplayItems.map((item) => (item.kind === "diff" ? item.file.fileName : item.path)),
      ),
    );
  }, [compact, allDisplayItems]);

  const toggleExpanded = useCallback((key: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const compactListSearch = listSearch;
  const compactFilteredItems = compactListSearch
    ? allDisplayItems.filter((item) => {
        const key = item.kind === "diff" ? item.file.fileName : item.path;
        return key.toLowerCase().includes(compactListSearch.toLowerCase());
      })
    : allDisplayItems;
  const compactTreeFiles = compactFilteredItems.map((item) =>
    item.kind === "diff"
      ? item.file
      : { fileName: item.path, hunks: [] as DiffFileWithName["hunks"], status: "A" as const },
  );

  const focusedItem = filteredItems[selectedFileIndex] ?? null;
  const focusedKey = focusedItem
    ? focusedItem.kind === "diff"
      ? focusedItem.file.fileName
      : focusedItem.path
    : null;
  const focusedBasename = focusedKey ? (focusedKey.split("/").pop() ?? focusedKey) : null;

  const navigateCompact = useCallback(
    (newIndex: number) => {
      const item = filteredItems[newIndex];
      if (!item) return;
      const key = item.kind === "diff" ? item.file.fileName : item.path;
      setSelectedFileIndex(newIndex);
      setExpandedFiles((prev) => {
        if (prev.has(key)) return prev;
        return new Set([...prev, key]);
      });
      programmaticScrollRef.current = true;
      setTimeout(() => {
        sectionRefs.current.get(key)?.scrollIntoView({ block: "start", behavior: "smooth" });
        setTimeout(() => {
          programmaticScrollRef.current = false;
        }, 700);
      }, 0);
    },
    [filteredItems],
  );

  const handleScroll = useCallback(() => {
    if (programmaticScrollRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const scrollTop = container.scrollTop;
    let activeIndex = 0;
    filteredItems.forEach((item, idx) => {
      const key = item.kind === "diff" ? item.file.fileName : item.path;
      const el = sectionRefs.current.get(key);
      if (el && el.offsetTop <= scrollTop + 1) activeIndex = idx;
    });
    setSelectedFileIndex(activeIndex);
  }, [filteredItems]);

  if (compact) {
    return (
      <div className="absolute inset-0 flex flex-col bg-background">
        {/* Compact header: [ListCollapse] | [‹ name ›] | [unified/split] */}
        <div className="flex items-center h-10 px-2 border-b border-border bg-card/50 shrink-0 gap-1">
          <button
            type="button"
            onClick={() => setListOpen((v) => !v)}
            className={cn(
              "p-1.5 rounded-md transition-colors shrink-0",
              listOpen
                ? "text-foreground bg-muted/60"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
            )}
            title="File list"
          >
            <ListCollapse className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-border shrink-0 mx-1" />
          <div className="flex-1 flex items-center justify-center gap-0.5 min-w-0 overflow-hidden">
            <button
              type="button"
              onClick={() => navigateCompact(selectedFileIndex - 1)}
              disabled={selectedFileIndex <= 0}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-30 disabled:pointer-events-none shrink-0"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs font-mono text-muted-foreground truncate max-w-[14rem]">
              {focusedBasename ??
                (filteredItems.length > 0 ? `${filteredItems.length} files` : "No changes")}
            </span>
            <button
              type="button"
              onClick={() => navigateCompact(selectedFileIndex + 1)}
              disabled={selectedFileIndex >= filteredItems.length - 1}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-30 disabled:pointer-events-none shrink-0"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="w-px h-4 bg-border shrink-0 mx-1" />
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              onClick={() => setDiffViewMode(DiffModeEnum.Unified)}
              className={cn(
                "p-1.5 rounded transition-colors",
                diffViewMode === DiffModeEnum.Unified
                  ? "text-foreground bg-muted/60"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
              )}
              title="Unified diff"
            >
              <AlignJustify className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setDiffViewMode(DiffModeEnum.SplitGitHub)}
              className={cn(
                "p-1.5 rounded transition-colors",
                diffViewMode !== DiffModeEnum.Unified
                  ? "text-foreground bg-muted/60"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
              )}
              title="Split diff"
            >
              <Columns2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* File-picker overlay */}
        {listOpen && (
          <div className="absolute top-10 left-0 right-0 bottom-0 z-20 flex flex-col bg-background border-b border-border">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
              <input
                autoFocus
                value={listSearch}
                onChange={(e) => setListSearch(e.target.value)}
                placeholder="Filter files..."
                className="flex-1 min-w-0 text-xs bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
              />
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setFileListMode("flat")}
                  className={cn(
                    "p-1.5 rounded text-xs transition-colors",
                    fileListMode === "flat"
                      ? "text-foreground bg-muted"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                  )}
                  title="Flat list"
                >
                  <List className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setFileListMode("tree")}
                  className={cn(
                    "p-1.5 rounded text-xs transition-colors",
                    fileListMode === "tree"
                      ? "text-foreground bg-muted"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                  )}
                  title="Tree view"
                >
                  <FolderTree className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              {fileListMode === "flat"
                ? compactFilteredItems.map((item, index) => {
                    const key = item.kind === "diff" ? item.file.fileName : item.path;
                    const basename = key.split("/").pop() ?? key;
                    const status = item.kind === "diff" ? (item.file.status ?? "M") : "A";
                    const statusColor =
                      status === "A"
                        ? "bg-success"
                        : status === "D"
                          ? "bg-destructive"
                          : "bg-warning";
                    const isFocused = index === selectedFileIndex;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          const idx = filteredItems.findIndex((i) =>
                            i.kind === "diff" ? i.file.fileName === key : i.path === key,
                          );
                          if (idx >= 0) navigateCompact(idx);
                          setListOpen(false);
                        }}
                        className={cn(
                          "flex items-center gap-2 w-full px-3 py-2 text-left transition-colors text-xs",
                          isFocused
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                        )}
                      >
                        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", statusColor)} />
                        <span className="truncate">{basename}</span>
                      </button>
                    );
                  })
                : (() => {
                    return (
                      <FileTree
                        files={compactTreeFiles}
                        selectedFile={focusedKey}
                        onSelectFile={(fileName) => {
                          const idx = filteredItems.findIndex((i) =>
                            i.kind === "diff" ? i.file.fileName === fileName : i.path === fileName,
                          );
                          if (idx >= 0) navigateCompact(idx);
                          setListOpen(false);
                        }}
                        viewedFiles={viewedFiles}
                      />
                    );
                  })()}
            </div>
          </div>
        )}

        {/* Stacked file cards with gaps */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto custom-scrollbar px-3 pb-3 flex flex-col"
        >
          {loading && (
            <div className="text-xs text-muted-foreground py-8 text-center animate-pulse">
              Loading...
            </div>
          )}
          {!loading && totalFileCount === 0 && !diffError && (
            <div className="text-xs text-muted-foreground py-8 text-center">No changes yet</div>
          )}
          {!loading &&
            filteredItems.map((item, index) => {
              const key = item.kind === "diff" ? item.file.fileName : item.path;
              const isExpanded = expandedFiles.has(key);
              const isViewed = viewedFiles.has(key);
              const isFocused = index === selectedFileIndex;

              return (
                <div
                  key={key}
                  ref={(el) => {
                    if (el) sectionRefs.current.set(key, el);
                    else sectionRefs.current.delete(key);
                  }}
                  className="shrink-0"
                >
                  <div className="sticky top-0 z-10 pt-3 bg-background">
                    <div
                      onClick={() => toggleExpanded(key)}
                      className={cn(
                        "border border-border bg-card flex items-center gap-2 px-2.5 py-2 cursor-pointer transition-colors",
                        isExpanded ? "rounded-t-lg" : "rounded-lg",
                        isFocused ? "bg-muted/40" : "hover:bg-muted/20",
                      )}
                    >
                      <ChevronRight
                        className={cn(
                          "w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform",
                          isExpanded && "rotate-90",
                        )}
                      />
                      <span className="text-xs font-mono truncate text-foreground/80 flex-1">
                        {key}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleViewed(key);
                        }}
                        className={cn(
                          "p-1 rounded transition-colors shrink-0",
                          isViewed
                            ? "text-success hover:bg-muted/30"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted/30",
                        )}
                        title={isViewed ? "Mark as unviewed" : "Mark as viewed"}
                      >
                        <CheckCheck className="size-3" />
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="border border-border border-t-0 rounded-b-lg overflow-auto custom-scrollbar">
                      {item.kind === "diff" ? (
                        <DiffViewer
                          diffFile={item.file}
                          loading={false}
                          diffViewMode={diffViewMode}
                        />
                      ) : (
                        <UntrackedFileDiffViewer
                          projectId={projectId}
                          worktreePath={cwd}
                          filePath={item.path}
                          showHeader={false}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </div>
    );
  }

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
          {selectedItem &&
            (() => {
              const fileName =
                selectedItem.kind === "diff" ? selectedItem.file.fileName : selectedItem.path;
              const status = selectedItem.kind === "diff" ? (selectedItem.file.status ?? "M") : "A";
              const stats =
                selectedItem.kind === "diff"
                  ? computeFileStats(selectedItem.file.hunks)
                  : { insertions: 0, deletions: 0 };
              const statusColor =
                status === "A"
                  ? "text-success"
                  : status === "D"
                    ? "text-destructive"
                    : "text-muted-foreground";
              const isViewed = viewedFiles.has(fileName);
              return (
                <div className="px-3 py-1.5 border-b border-border bg-muted/20 shrink-0 flex items-center gap-2 text-xs">
                  <span className="font-mono text-foreground truncate flex-1">{fileName}</span>
                  <span className={cn("font-medium shrink-0", statusColor)}>{status}</span>
                  {stats.insertions > 0 && (
                    <span className="text-success shrink-0">+{stats.insertions}</span>
                  )}
                  {stats.deletions > 0 && (
                    <span className="text-destructive shrink-0">-{stats.deletions}</span>
                  )}
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
