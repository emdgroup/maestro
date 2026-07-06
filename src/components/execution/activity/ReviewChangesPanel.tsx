import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import {
  X,
  Columns2,
  Files,
  CheckCheck,
  ChevronRight,
  ChevronLeft,
  AlignJustify,
} from "lucide-react";
import { DiffModeEnum } from "@git-diff-view/react";
import { cn } from "@/lib/utils.ts";
import { DiffViewer } from "@/components/execution/diff/DiffViewer";
import { FileSelector } from "@/components/execution/diff/FileSelector";
import { parseDiffString, computeFileStats } from "@/lib/diff-utils";
import { useWorktreeDiffQuery } from "@/services/worktree.service";
import { useAcpSessionMeta } from "@/services/execution.service";
import { UntrackedFileDiffViewer } from "@/components/execution/diff/UntrackedFileDiffViewer";
import type { DiffFileWithName } from "@/types/review";

type DisplayItem = { kind: "diff"; file: DiffFileWithName } | { kind: "untracked"; path: string };

interface ReviewChangesPanelProps {
  sessionKey: number;
  sessionChangedFiles: string[];
  onClose: () => void;
  initialFile?: string;
  compact?: boolean;
  isActive?: boolean;
  onDiffStats?: (stats: { insertions: number; deletions: number } | null) => void;
}

function DiffStats({ hunks }: { hunks: string[] }) {
  const s = computeFileStats(hunks);
  return (
    <span className="flex items-center gap-1 shrink-0 text-xs font-mono">
      {s.insertions > 0 && <span className="text-success">+{s.insertions}</span>}
      {s.deletions > 0 && <span className="text-destructive">-{s.deletions}</span>}
    </span>
  );
}

function SelectedFileHeader({
  selectedItem,
  viewedFiles,
  onToggleViewed,
}: {
  selectedItem: DisplayItem;
  viewedFiles: Set<string>;
  onToggleViewed: (fileName: string) => void;
}) {
  const fileName = selectedItem.kind === "diff" ? selectedItem.file.fileName : selectedItem.path;
  const status = selectedItem.kind === "diff" ? (selectedItem.file.status ?? "M") : "A";
  const stats =
    selectedItem.kind === "diff"
      ? computeFileStats(selectedItem.file.hunks)
      : { insertions: 0, deletions: 0 };
  const statusColor =
    status === "A" ? "text-success" : status === "D" ? "text-destructive" : "text-muted-foreground";
  const isViewed = viewedFiles.has(fileName);
  return (
    <div className="px-3 py-1.5 border-b border-border bg-muted/20 shrink-0 flex items-center gap-2 text-xs">
      <span className="font-mono text-foreground truncate flex-1">{fileName}</span>
      <span className={cn("font-medium shrink-0", statusColor)}>{status}</span>
      {stats.insertions > 0 && <span className="text-success shrink-0">+{stats.insertions}</span>}
      {stats.deletions > 0 && <span className="text-destructive shrink-0">-{stats.deletions}</span>}
      <button
        onClick={() => onToggleViewed(fileName)}
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
}

export function ReviewChangesPanel({
  sessionKey,
  sessionChangedFiles,
  onClose,
  initialFile,
  compact = false,
  isActive = true,
  onDiffStats,
}: ReviewChangesPanelProps) {
  const [diffViewMode, setDiffViewMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());
  const [listOpen, setListOpen] = useState(false);
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

  const { data: sessionMeta, isError: metaError } = useAcpSessionMeta(sessionKey ?? null);
  const projectId = sessionMeta?.project_id ?? null;
  const cwd = sessionMeta?.cwd ?? null;
  const startSha = sessionMeta?.session_start_sha ?? null;

  const diffTarget = useMemo(
    () => (startSha ? ({ type: "Commit", sha: startSha } as const) : ({ type: "Head" } as const)),
    [startSha],
  );

  const {
    data: diffResult,
    isLoading: diffLoading,
    error: diffError,
  } = useWorktreeDiffQuery(projectId, cwd, diffTarget, {
    refetchInterval: isActive ? 10000 : false,
  });

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

  const selectedItem: DisplayItem | null = allDisplayItems[selectedFileIndex] ?? null;
  const selectedUntrackedPath = selectedItem?.kind === "untracked" ? selectedItem.path : null;

  const loading = diffLoading || (projectId === null && cwd === null && !metaError);
  const totalFileCount = diffFiles.length + untrackedFiles.length;

  const totalStats = useMemo(() => {
    if (diffFiles.length === 0) return null;
    let insertions = 0;
    let deletions = 0;
    for (const f of diffFiles) {
      const s = computeFileStats(f.hunks);
      insertions += s.insertions;
      deletions += s.deletions;
    }
    return { insertions, deletions };
  }, [diffFiles]);

  useEffect(() => {
    onDiffStats?.(totalStats);
  }, [totalStats, onDiffStats]);

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

  const focusedItem = allDisplayItems[selectedFileIndex] ?? null;
  const focusedKey = focusedItem
    ? focusedItem.kind === "diff"
      ? focusedItem.file.fileName
      : focusedItem.path
    : null;
  const focusedBasename = focusedKey ? (focusedKey.split("/").pop() ?? focusedKey) : null;

  const fileSelectorFiles = useMemo(
    () =>
      allDisplayItems.map((item) => ({
        fileName: item.kind === "diff" ? item.file.fileName : item.path,
        status: item.kind === "diff" ? (item.file.status ?? ("M" as const)) : ("A" as const),
      })),
    [allDisplayItems],
  );

  const navigateCompact = useCallback(
    (newIndex: number) => {
      const item = allDisplayItems[newIndex];
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
    [allDisplayItems],
  );

  const handleScroll = useCallback(() => {
    if (programmaticScrollRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const scrollTop = container.scrollTop;
    let activeIndex = 0;
    allDisplayItems.forEach((item, idx) => {
      const key = item.kind === "diff" ? item.file.fileName : item.path;
      const el = sectionRefs.current.get(key);
      if (el && el.offsetTop <= scrollTop + 1) activeIndex = idx;
    });
    setSelectedFileIndex(activeIndex);
  }, [allDisplayItems]);

  function onFileSelectorSelect(fileName: string) {
    const idx = allDisplayItems.findIndex((i) =>
      i.kind === "diff" ? i.file.fileName === fileName : i.path === fileName,
    );
    if (idx >= 0) {
      if (compact) navigateCompact(idx);
      else setSelectedFileIndex(idx);
    }
    setListOpen(false);
  }

  const filePickerOverlay = listOpen ? (
    <>
      <div
        className="absolute inset-x-0 bottom-0 z-30 bg-background border-r border-border flex flex-col"
        style={{ top: "2.5rem", width: "14rem" }}
      >
        <FileSelector
          files={fileSelectorFiles}
          selectedFile={focusedKey}
          onSelectFile={onFileSelectorSelect}
          viewedFiles={viewedFiles}
          className="flex-1 min-h-0"
        />
      </div>
      <div
        className="absolute inset-0 z-20"
        style={{ top: "2.5rem" }}
        onClick={() => setListOpen(false)}
      />
    </>
  ) : null;

  if (compact) {
    return (
      <div className="absolute inset-0 flex flex-col bg-background">
        {/* Compact header: [Files] | [‹ name ›] | [unified/split] */}
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
            <Files className="w-4 h-4" />
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
                (allDisplayItems.length > 0 ? `${allDisplayItems.length} files` : "No changes")}
            </span>
            <button
              type="button"
              onClick={() => navigateCompact(selectedFileIndex + 1)}
              disabled={selectedFileIndex >= allDisplayItems.length - 1}
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

        {filePickerOverlay}

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
            allDisplayItems.map((item, index) => {
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
                      {item.kind === "diff" && <DiffStats hunks={item.file.hunks} />}
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

  // Normal mode (currently unused — kept for future)
  const selectedFileName =
    selectedItem?.kind === "diff" ? selectedItem.file.fileName : (selectedItem?.path ?? null);
  const selectedBasename = selectedFileName
    ? (selectedFileName.split("/").pop() ?? selectedFileName)
    : null;

  let diffContent: ReactNode;
  if (loading) {
    diffContent = (
      <div className="flex-1 min-h-0 overflow-auto custom-scrollbar">
        <DiffViewer diffFile={null} loading={true} diffViewMode={diffViewMode} />
      </div>
    );
  } else if (selectedItem?.kind === "diff") {
    diffContent = (
      <div className="flex-1 min-h-0 overflow-auto custom-scrollbar">
        <DiffViewer diffFile={selectedItem.file} loading={false} diffViewMode={diffViewMode} />
      </div>
    );
  } else if (selectedItem?.kind === "untracked") {
    diffContent = (
      <UntrackedFileDiffViewer
        projectId={projectId}
        worktreePath={cwd}
        filePath={selectedUntrackedPath}
        showHeader={false}
      />
    );
  } else {
    diffContent = (
      <div className="flex-1 min-h-0 overflow-auto custom-scrollbar">
        <DiffViewer
          diffFile={null}
          loading={false}
          error={diffError ? String(diffError) : undefined}
        />
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
      {/* Header */}
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
          <Files className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-border shrink-0 mx-1" />
        <div className="flex-1 flex items-center justify-center min-w-0">
          <span className="text-xs font-mono text-muted-foreground truncate">
            {selectedBasename ?? "No file selected"}
          </span>
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
        <div className="w-px h-4 bg-border shrink-0 mx-1" />
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {filePickerOverlay}

      {/* Diff viewer */}
      <div className="flex-1 min-h-0 min-w-0 flex flex-col">
        {selectedItem && (
          <SelectedFileHeader
            selectedItem={selectedItem}
            viewedFiles={viewedFiles}
            onToggleViewed={toggleViewed}
          />
        )}
        {diffContent}
      </div>
    </div>
  );
}
