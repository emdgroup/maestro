import { useState, useEffect, useCallback, useRef } from "react";
import {
  Files,
  CheckCheck,
  ChevronRight,
  ChevronLeft,
  AlignJustify,
  Columns2,
  TriangleAlert,
} from "lucide-react";
import { DiffModeEnum } from "@git-diff-view/react";
import { cn } from "@/lib/utils.ts";
import { DiffViewer } from "@/components/execution/diff/DiffViewer";
import { FileSelector } from "@/components/execution/diff/FileSelector";
import { computeFileStats } from "@/lib/diff-utils";
import { UntrackedFileDiffViewer } from "@/components/execution/diff/UntrackedFileDiffViewer";
import type { DisplayItem } from "./useReviewChangesData";

function DiffStats({ hunks }: { hunks: string[] }) {
  const s = computeFileStats(hunks);
  return (
    <span className="flex items-center gap-1 shrink-0 text-xs font-mono">
      {s.insertions > 0 && <span className="text-success">+{s.insertions}</span>}
      {s.deletions > 0 && <span className="text-destructive">-{s.deletions}</span>}
    </span>
  );
}

interface TruncationInfo {
  diffTruncated: boolean;
  totalDiffBytes: number;
  untrackedTruncated: boolean;
  totalUntracked: number;
}

interface ReviewChangesPanelCompactProps {
  allDisplayItems: DisplayItem[];
  loading: boolean;
  totalFileCount: number;
  diffError: unknown;
  projectId: number | null;
  cwd: string | null;
  truncationInfo?: TruncationInfo | null;
  diffViewMode: DiffModeEnum;
  setDiffViewMode: (mode: DiffModeEnum) => void;
  selectedFileIndex: number;
  setSelectedFileIndex: (idx: number) => void;
  viewedFiles: Set<string>;
  toggleViewed: (fileName: string) => void;
  listOpen: boolean;
  setListOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  fileSelectorFiles: Array<{ fileName: string; status: "M" | "A" | "D" }>;
  focusedKey: string | null;
  focusedBasename: string | null;
}

export function ReviewChangesPanelCompact({
  allDisplayItems,
  loading,
  totalFileCount,
  diffError,
  projectId,
  cwd,
  truncationInfo,
  diffViewMode,
  setDiffViewMode,
  selectedFileIndex,
  setSelectedFileIndex,
  viewedFiles,
  toggleViewed,
  listOpen,
  setListOpen,
  fileSelectorFiles,
  focusedKey,
  focusedBasename,
}: ReviewChangesPanelCompactProps) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const expandedInitRef = useRef(false);
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const programmaticScrollRef = useRef(false);

  // Auto-expand all files on first load, but only for small diffs — mounting hundreds
  // of DiffViewer components at once exhausts WebView2 memory.
  // ponytail: collapse by default when > 20 files — prevents N DiffViewer mounts on load
  useEffect(() => {
    if (allDisplayItems.length === 0 || expandedInitRef.current) return;
    expandedInitRef.current = true;
    if (allDisplayItems.length <= 20) {
      setExpandedFiles(
        new Set(
          allDisplayItems.map((item) => (item.kind === "diff" ? item.file.fileName : item.path)),
        ),
      );
    }
  }, [allDisplayItems]);

  const toggleExpanded = useCallback((key: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

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
    [allDisplayItems, setSelectedFileIndex],
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
  }, [allDisplayItems, setSelectedFileIndex]);

  function onFileSelectorSelect(fileName: string) {
    const idx = allDisplayItems.findIndex((i) =>
      i.kind === "diff" ? i.file.fileName === fileName : i.path === fileName,
    );
    if (idx >= 0) navigateCompact(idx);
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

      {truncationInfo && (
        <div className="flex items-start gap-2 px-3 py-2 border-b border-border bg-amber-500/5 text-amber-400 shrink-0">
          <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div className="flex flex-col gap-0.5 text-xs">
            <span className="font-medium">Diff too large — partial view</span>
            <span className="text-amber-400/70">
              {truncationInfo.diffTruncated &&
                `Diff: ${Math.round(truncationInfo.totalDiffBytes / 1_048_576)} MB total, showing first 2 MB. `}
              {truncationInfo.untrackedTruncated &&
                `Untracked: ${truncationInfo.totalUntracked.toLocaleString()} files, showing first 500.`}
            </span>
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
                          : "text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/30",
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
