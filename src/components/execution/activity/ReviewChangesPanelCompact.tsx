import { useCallback, useMemo, useRef, useState } from "react";
import {
  PanelLeft,
  ChevronRight,
  ChevronLeft,
  AlignJustify,
  Columns2,
  TriangleAlert,
} from "lucide-react";
import { DiffModeEnum } from "@git-diff-view/react";
import { cn } from "@/lib/utils.ts";
import { ReviewLayout } from "@/components/execution/diff/ReviewLayout";
import { useReviewPanelLayout } from "@/components/execution/diff/useReviewPanelLayout";
import {
  DiffFileStack,
  type DiffFileStackHandle,
  type DiffReviewApi,
} from "@/components/execution/diff/DiffFileStack";
import { displayItemPath, type DisplayItem } from "@/types/review";
import type { DiffTarget } from "@/types/bindings";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { AnnotationBar } from "@/components/execution/side-panel/annotations/AnnotationBar";
import { useAnnotationStore, useSessionAnnotations } from "@/store/annotationStore";
import type { Annotation, DiffAnnotation } from "@/store/annotationStore";

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
  /** What the diff compares against — the base revision a hunk expansion reads its context from. */
  diffTarget: DiffTarget;
  truncationInfo?: TruncationInfo | null;
  scope: "session" | "uncommitted";
  diffViewMode: DiffModeEnum;
  setDiffViewMode: (mode: DiffModeEnum) => void;
  selectedFileIndex: number;
  setSelectedFileIndex: (idx: number) => void;
  viewedFiles: Set<string>;
  toggleViewed: (fileName: string) => void;
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
  diffTarget,
  truncationInfo,
  scope,
  diffViewMode,
  setDiffViewMode,
  selectedFileIndex,
  setSelectedFileIndex,
  viewedFiles,
  toggleViewed,
  fileSelectorFiles,
  focusedKey,
  focusedBasename,
  onOpenFile,
}: ReviewChangesPanelCompactProps) {
  const scopeLabel = scope === "session" ? "since session start" : "uncommitted changes only";
  const annotations = useSessionAnnotations(sessionKey, "diff");
  const { addAnnotation, updateAnnotation, removeAnnotations } = useAnnotationStore();
  const stackRef = useRef<DiffFileStackHandle>(null);
  const [fileSearch, setFileSearch] = useState("");
  const panel = useReviewPanelLayout();

  const navigateCompact = useCallback((index: number) => {
    stackRef.current?.navigateTo(index);
  }, []);

  function onFileSelectorSelect(fileName: string) {
    const idx = allDisplayItems.findIndex((i) => displayItemPath(i) === fileName);
    if (idx >= 0) navigateCompact(idx);
  }

  const diffAnnotations = useMemo(
    () => annotations.filter((a): a is DiffAnnotation => a.kind === "diff"),
    [annotations],
  );

  // Memoized because its identity reaches every DiffViewer's `renderExtendLine` through the stack:
  // a fresh object here re-renders every comment in every open diff on each render of this panel.
  const review = useMemo<DiffReviewApi>(
    () => ({
      comments: diffAnnotations,
      onSubmitComment: (filePath, lineNumber, fromLineNumber, side, text) => {
        // Keyed on the end line and deliberately not on the range: `extendData` holds one comment
        // per line and side, so a second one ending here would have nowhere to render.
        const existing = diffAnnotations.find(
          (a) => a.filePath === filePath && a.lineNumber === lineNumber && a.side === side,
        );
        if (existing) updateAnnotation(sessionKey, existing.id, text, fromLineNumber);
        else
          addAnnotation(sessionKey, {
            id: crypto.randomUUID(),
            kind: "diff",
            filePath,
            lineNumber,
            fromLineNumber,
            side,
            text,
          });
      },
      onRemoveComment: (id) => removeAnnotations(sessionKey, [id]),
      onEditComment: (id, text) => updateAnnotation(sessionKey, id, text),
      onSendComment: (id) => {
        const target = diffAnnotations.find((a) => a.id === id);
        if (target) onSendAnnotations([target]);
      },
      sendDisabled: annotationSendDisabled,
    }),
    [
      diffAnnotations,
      sessionKey,
      addAnnotation,
      updateAnnotation,
      removeAnnotations,
      onSendAnnotations,
      annotationSendDisabled,
    ],
  );

  return (
    <div className="absolute inset-0 flex flex-col bg-card">
      {/* Compact header: [Files] | [‹ name ›] | [unified/split]. Takes the same gap above it that
          the diff's inset leaves below, so its contents stay on the band's centre line. */}
      <div
        className={cn("flex items-center h-10 px-2 bg-card shrink-0 gap-1", panel.inset && "mt-2")}
      >
        <Tooltip>
          <TooltipTrigger
            type="button"
            aria-label={panel.panelOpen ? "Hide file list" : "Show file list"}
            onClick={() => panel.setPanelOpen(!panel.panelOpen)}
            className={cn(
              "p-1.5 rounded-md transition-colors shrink-0",
              panel.panelOpen
                ? "text-foreground bg-muted/60"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
            )}
          >
            <PanelLeft className="w-4 h-4" />
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

      {/* Beside the stack when the panel is wide enough for both, floating over it otherwise —
          the same toggle drives either. */}
      <ReviewLayout
        panel={panel}
        files={{
          files: fileSelectorFiles,
          selectedFile: focusedKey,
          onSelectFile: onFileSelectorSelect,
          viewedFiles,
          search: fileSearch,
          onSearchChange: setFileSearch,
        }}
      >
        <DiffFileStack
          ref={stackRef}
          items={allDisplayItems}
          projectId={projectId}
          cwd={cwd}
          diffTarget={diffTarget}
          diffViewMode={diffViewMode}
          selectedIndex={selectedFileIndex}
          onSelectedIndexChange={setSelectedFileIndex}
          viewedFiles={viewedFiles}
          onToggleViewed={toggleViewed}
          review={review}
          // Diff paths are relative to the session worktree, which is not where the Files tab
          // resolves relative paths — hand it an absolute path and let it work out the prefix.
          onOpenFile={onOpenFile ? (path) => onOpenFile(cwd ? `${cwd}/${path}` : path) : undefined}
          loading={loading}
          emptyMessage={totalFileCount === 0 && !diffError ? `No changes ${scopeLabel}` : undefined}
        />
      </ReviewLayout>
    </div>
  );
}
