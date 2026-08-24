import { useState, useCallback, useMemo, useRef } from "react";
import {
  Files,
  CheckCheck,
  Check,
  ChevronRight,
  ChevronLeft,
  AlignJustify,
  Columns2,
  Copy,
  TriangleAlert,
} from "lucide-react";
import { DiffModeEnum } from "@git-diff-view/react";
import { cn } from "@/lib/utils.ts";
import { DiffViewer } from "@/components/execution/diff/DiffViewer";
import { FileSelector } from "@/components/execution/diff/FileSelector";
import { computeFileStats } from "@/lib/diff-utils";
import { UntrackedFileDiffViewer } from "@/components/execution/diff/UntrackedFileDiffViewer";
import type { DisplayItem } from "./useReviewChangesData";
import { useCopyToClipboard } from "./HighlightedCode";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { AnnotationBar } from "@/components/execution/side-panel/annotations/AnnotationBar";
import { useAnnotationStore, useSessionAnnotations } from "@/store/annotationStore";
import type { Annotation, DiffAnnotation } from "@/store/annotationStore";

// Its own component because the file cards are rendered in a loop and the copy
// hook holds the "copied" flag per path.
function CopyPathButton({ path }: { path: string }) {
  const { copied, copy } = useCopyToClipboard(path);
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          copy();
        }}
        className="p-1 rounded transition-colors shrink-0 text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/30"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy path"}</TooltipContent>
    </Tooltip>
  );
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

interface TruncationInfo {
  diffTruncated: boolean;
  totalDiffBytes: number;
  untrackedTruncated: boolean;
  totalUntracked: number;
}

interface ReviewChangesPanelCompactProps {
  sessionKey: number;
  onSendAnnotations: (annotations: Annotation[]) => void;
  annotationSendDisabled?: boolean;
  allDisplayItems: DisplayItem[];
  loading: boolean;
  totalFileCount: number;
  diffError: unknown;
  projectId: number | null;
  cwd: string | null;
  truncationInfo?: TruncationInfo | null;
  scope: "session" | "uncommitted";
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
  /** Opens a path (absolute, or project-relative) in a Files tab. */
  onOpenFile?: (path: string) => void;
}

export function ReviewChangesPanelCompact({
  sessionKey,
  onSendAnnotations,
  annotationSendDisabled,
  allDisplayItems,
  loading,
  totalFileCount,
  diffError,
  projectId,
  cwd,
  truncationInfo,
  scope,
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
  onOpenFile,
}: ReviewChangesPanelCompactProps) {
  const scopeLabel = scope === "session" ? "since session start" : "uncommitted changes only";
  const annotations = useSessionAnnotations(sessionKey, "diff");
  const { addAnnotation, updateAnnotation, removeAnnotations } = useAnnotationStore();
  // Which line is currently taking a new comment. Unlike TaskReviewPanel this panel renders one
  // DiffViewer per file, so the file has to be part of the key.
  const [activeCommentLine, setActiveCommentLine] = useState<{
    filePath: string;
    lineNumber: number;
    side: "old" | "new";
  } | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const programmaticScrollRef = useRef(false);

  // Auto-expand all files on first load, but only for small diffs — mounting hundreds
  // of DiffViewer components at once exhausts WebView2 memory.
  // ponytail: collapse by default when > 20 files — prevents N DiffViewer mounts on load
  //
  // Runs once, on the first render where the async diff has produced items. Expressed
  // during render with the one-shot flag in state rather than a ref, so nothing is read
  // or written mid-render that the compiler cannot follow.
  const [expandedSeeded, setExpandedSeeded] = useState(false);
  if (!expandedSeeded && allDisplayItems.length > 0) {
    setExpandedSeeded(true);
    if (allDisplayItems.length <= 20) {
      setExpandedFiles(
        new Set(
          allDisplayItems.map((item) => (item.kind === "diff" ? item.file.fileName : item.path)),
        ),
      );
    }
  }

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

  /**
   * Every pending comment in the review, in the order they are read on screen: by file as the
   * panel lists them, then by line. The chevrons on a comment walk this, not the current file, so
   * the position it shows agrees with the count in the annotation bar.
   */
  const orderedComments = useMemo(() => {
    const fileOrder = new Map(
      allDisplayItems.map((item, i) => [item.kind === "diff" ? item.file.fileName : item.path, i]),
    );
    return annotations
      .filter((a): a is DiffAnnotation => a.kind === "diff")
      .sort(
        (a, b) =>
          (fileOrder.get(a.filePath) ?? Number.MAX_SAFE_INTEGER) -
            (fileOrder.get(b.filePath) ?? Number.MAX_SAFE_INTEGER) || a.lineNumber - b.lineNumber,
      );
  }, [annotations, allDisplayItems]);

  /**
   * Reveal a comment, opening and scrolling to its file first when it lives in another one.
   *
   * The comment itself is inside a diff this component does not render, so it is found by the
   * `data-comment-id` the viewer tags it with rather than through a ref. The delay is the file
   * section's own smooth scroll — until that settles the comment is not laid out where it will be.
   */
  const goToComment = useCallback(
    (id: string) => {
      const target = orderedComments.find((c) => c.id === id);
      if (!target) return;
      const index = allDisplayItems.findIndex((item) =>
        item.kind === "diff"
          ? item.file.fileName === target.filePath
          : item.path === target.filePath,
      );
      if (index >= 0 && index !== selectedFileIndex) navigateCompact(index);
      const reveal = () =>
        scrollContainerRef.current
          ?.querySelector(`[data-comment-id="${CSS.escape(id)}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      if (index >= 0 && index !== selectedFileIndex) setTimeout(reveal, 400);
      else requestAnimationFrame(reveal);
    },
    [orderedComments, allDisplayItems, selectedFileIndex, navigateCompact],
  );

  const commentNav = useCallback(
    (id: string) => {
      if (orderedComments.length < 2) return null;
      const at = orderedComments.findIndex((c) => c.id === id);
      if (at < 0) return null;
      const step = (delta: 1 | -1) =>
        goToComment(
          orderedComments[(at + delta + orderedComments.length) % orderedComments.length].id,
        );
      return {
        onPrev: () => step(-1),
        onNext: () => step(1),
        position: [at + 1, orderedComments.length] as [number, number],
      };
    },
    [orderedComments, goToComment],
  );

  // Review-mode wiring shared by DiffViewer and UntrackedFileDiffViewer, per file.
  const reviewProps = useCallback(
    (filePath: string) => ({
      reviewMode: true,
      comments: annotations.filter(
        (a): a is DiffAnnotation => a.kind === "diff" && a.filePath === filePath,
      ),
      onAddComment: (lineNumber: number, side: "old" | "new") =>
        setActiveCommentLine({ filePath, lineNumber, side }),
      onCancelComment: () => setActiveCommentLine(null),
      onSubmitComment: (text: string) => {
        const line = activeCommentLine;
        if (!line || line.filePath !== filePath) return;
        addAnnotation(sessionKey, {
          id: crypto.randomUUID(),
          kind: "diff" as const,
          filePath,
          lineNumber: line.lineNumber,
          side: line.side,
          text,
        });
        setActiveCommentLine(null);
      },
      onRemoveComment: (id: string) => removeAnnotations(sessionKey, [id]),
      onEditComment: (id: string, text: string) => updateAnnotation(sessionKey, id, text),
      onSendComment: (id: string) => {
        const target = annotations.find((a) => a.id === id);
        if (target) onSendAnnotations([target]);
      },
      commentNav,
      sendDisabled: annotationSendDisabled,
    }),
    [
      annotations,
      activeCommentLine,
      sessionKey,
      addAnnotation,
      removeAnnotations,
      updateAnnotation,
      onSendAnnotations,
      annotationSendDisabled,
      commentNav,
    ],
  );

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
        <Tooltip>
          <TooltipTrigger
            type="button"
            onClick={() => setListOpen((v) => !v)}
            className={cn(
              "p-1.5 rounded-md transition-colors shrink-0",
              listOpen
                ? "text-foreground bg-muted/60"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
            )}
          >
            <Files className="w-4 h-4" />
          </TooltipTrigger>
          <TooltipContent>File list — {scopeLabel}</TooltipContent>
        </Tooltip>
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
        <AnnotationBar
          sessionKey={sessionKey}
          kind="diff"
          onSend={onSendAnnotations}
          sendDisabled={annotationSendDisabled}
        />
        <div className="w-px h-4 bg-border shrink-0 mx-1" />
        <div className="flex items-center gap-0.5 shrink-0">
          <Tooltip>
            <TooltipTrigger
              type="button"
              onClick={() => setDiffViewMode(DiffModeEnum.Unified)}
              className={cn(
                "p-1.5 rounded transition-colors",
                diffViewMode === DiffModeEnum.Unified
                  ? "text-foreground bg-muted/60"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
              )}
            >
              <AlignJustify className="w-3.5 h-3.5" />
            </TooltipTrigger>
            <TooltipContent>Unified diff</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              type="button"
              onClick={() => setDiffViewMode(DiffModeEnum.SplitGitHub)}
              className={cn(
                "p-1.5 rounded transition-colors",
                diffViewMode !== DiffModeEnum.Unified
                  ? "text-foreground bg-muted/60"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
              )}
            >
              <Columns2 className="w-3.5 h-3.5" />
            </TooltipTrigger>
            <TooltipContent>Split diff</TooltipContent>
          </Tooltip>
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
          <div className="text-xs text-muted-foreground py-8 text-center">
            No changes {scopeLabel}
          </div>
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
                    {onOpenFile ? (
                      // The wrapper takes the free space so the stats stay right-aligned;
                      // the button itself only spans the file name, so clicking the empty
                      // rest of the row still toggles the diff.
                      <div className="flex-1 min-w-0 flex">
                        <Tooltip>
                          <TooltipTrigger
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              // Diff paths are relative to the session worktree, which is not
                              // where the Files tab resolves relative paths — hand it an
                              // absolute path and let it work out the prefix.
                              onOpenFile(cwd ? `${cwd}/${key}` : key);
                            }}
                            className="text-xs font-mono truncate max-w-full text-foreground/80 text-left hover:underline underline-offset-2 hover:text-foreground transition-colors"
                          >
                            {key}
                          </TooltipTrigger>
                          <TooltipContent>Open in a Files tab</TooltipContent>
                        </Tooltip>
                      </div>
                    ) : (
                      <span className="text-xs font-mono truncate text-foreground/80 flex-1">
                        {key}
                      </span>
                    )}
                    {item.kind === "diff" && <DiffStats hunks={item.file.hunks} />}
                    <CopyPathButton path={key} />
                    <Tooltip>
                      <TooltipTrigger
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
                      >
                        <CheckCheck className="size-3" />
                      </TooltipTrigger>
                      <TooltipContent>
                        {isViewed ? "Mark as unviewed" : "Mark as viewed"}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
                {isExpanded && (
                  <div className="border border-border border-t-0 rounded-b-lg overflow-auto custom-scrollbar">
                    {item.kind === "diff" ? (
                      item.file.hunks.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-muted-foreground">
                          {item.file.note ?? "No textual diff"}
                        </div>
                      ) : (
                        <DiffViewer
                          diffFile={item.file}
                          loading={false}
                          diffViewMode={diffViewMode}
                          {...reviewProps(key)}
                        />
                      )
                    ) : (
                      <UntrackedFileDiffViewer
                        projectId={projectId}
                        worktreePath={cwd}
                        filePath={item.path}
                        showHeader={false}
                        {...reviewProps(key)}
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
