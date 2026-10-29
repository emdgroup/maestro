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
import { cn } from "@/lib/utils";
import { ReviewLayout } from "@/components/execution/diff/ReviewLayout";
import { useReviewPanelLayout } from "@/components/execution/diff/useReviewPanelLayout";
import {
  DiffFileStack,
  type DiffFileStackHandle,
  type DiffReviewApi,
} from "@/components/execution/diff/DiffFileStack";
import { displayItemPath, type DisplayItem, type FileStatus } from "@/types/review";
import type { CommitInfo, DiffTarget } from "@/types/bindings";
import { ScopeSelector } from "@/components/execution/diff/ScopeSelector";
import type { DiffScope } from "@/components/execution/diff/scope";
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
  sessionId: string;
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
  scope: DiffScope;
  onScopeChange: (scope: DiffScope) => void;
  commits: CommitInfo[];
  commitsLoading: boolean;
  uncommittedFileCount: number;
  allChangesFileCount: number;
  diffViewMode: DiffModeEnum;
  setDiffViewMode: (mode: DiffModeEnum) => void;
  /** Null until the reader picks a file — the tab opens with nothing selected. */
  selectedFileIndex: number | null;
  setSelectedFileIndex: (idx: number) => void;
  viewedFiles: Set<string>;
  toggleViewed: (fileName: string) => void;
  fileSelectorFiles: Array<{ fileName: string; status: FileStatus }>;
  focusedKey: string | null;
  focusedBasename: string | null;
  /** Opens a path (absolute, or project-relative) in a Files tab. */
  onOpenFile?: (path: string) => void;
}

export function ReviewChangesPanelCompact({
  sessionId,
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
  onScopeChange,
  commits,
  commitsLoading,
  uncommittedFileCount,
  allChangesFileCount,
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
  const annotations = useSessionAnnotations(sessionId, "diff");
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

  // With nothing picked yet the forward chevron enters the stack at its first file, and there is
  // nothing behind that to step back to.
  const prevIndex = selectedFileIndex === null ? -1 : selectedFileIndex - 1;
  const nextIndex = selectedFileIndex === null ? 0 : selectedFileIndex + 1;

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
        if (existing) updateAnnotation(sessionId, existing.id, text, fromLineNumber);
        else
          addAnnotation(sessionId, {
            id: crypto.randomUUID(),
            kind: "diff",
            filePath,
            lineNumber,
            fromLineNumber,
            side,
            text,
          });
      },
      onRemoveComment: (id) => removeAnnotations(sessionId, [id]),
      onEditComment: (id, text) => updateAnnotation(sessionId, id, text),
      onSendComment: (id) => {
        const target = diffAnnotations.find((a) => a.id === id);
        if (target) onSendAnnotations([target]);
      },
      sendDisabled: annotationSendDisabled,
    }),
    [
      diffAnnotations,
      sessionId,
      addAnnotation,
      updateAnnotation,
      removeAnnotations,
      onSendAnnotations,
      annotationSendDisabled,
    ],
  );

  return (
    <div className="absolute inset-0 flex flex-col">
      {/* Compact header: [Files] | [‹ name ›] | [unified/split]. Takes the same gap above it that
          the diff's inset leaves below, so its contents stay on the band's centre line. */}
      <div className={cn("flex items-center h-10 px-2 shrink-0 gap-1", panel.inset && "mt-2")}>
        <Tooltip>
          <TooltipTrigger
            type="button"
            aria-label={panel.panelOpen ? "Hide file list" : "Show file list"}
            onClick={() => panel.setPanelOpen(!panel.panelOpen)}
            className={cn(
              "p-1.5 rounded-lg transition-colors shrink-0",
              panel.panelOpen
                ? "text-foreground bg-foreground/7"
                : "text-muted-foreground hover:text-foreground hover:bg-foreground/7",
            )}
          >
            <PanelLeft className="w-4 h-4" />
          </TooltipTrigger>
          <TooltipContent>{panel.panelOpen ? "Hide file list" : "Show file list"}</TooltipContent>
        </Tooltip>
        <ScopeSelector
          selectedScope={scope}
          onScopeChange={onScopeChange}
          commits={commits}
          uncommittedFileCount={uncommittedFileCount}
          allChangesFileCount={allChangesFileCount}
          isLoading={commitsLoading}
        />
        <div className="w-px h-4 bg-border shrink-0 mx-1" />
        <div className="flex-1 flex items-center justify-center gap-0.5 min-w-0 overflow-hidden">
          <button
            type="button"
            onClick={() => navigateCompact(prevIndex)}
            disabled={prevIndex < 0}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/7 transition-colors disabled:opacity-30 disabled:pointer-events-none shrink-0"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs font-mono text-muted-foreground truncate max-w-[14rem]">
            {focusedBasename ??
              (allDisplayItems.length > 0 ? `${allDisplayItems.length} files` : "No changes")}
          </span>
          <button
            type="button"
            onClick={() => navigateCompact(nextIndex)}
            disabled={nextIndex > allDisplayItems.length - 1}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/7 transition-colors disabled:opacity-30 disabled:pointer-events-none shrink-0"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <AnnotationBar
          sessionId={sessionId}
          kind="diff"
          onSend={onSendAnnotations}
          sendDisabled={annotationSendDisabled}
        />
        <div className="w-px h-4 bg-border shrink-0 mx-1" />
        <div className="flex items-center gap-0.5 shrink-0 rounded-xl border border-foreground/10 bg-background/45 p-[3px]">
          <Tooltip>
            <TooltipTrigger
              type="button"
              onClick={() => setDiffViewMode(DiffModeEnum.Unified)}
              className={cn(
                "p-1 rounded-lg transition-colors",
                diffViewMode === DiffModeEnum.Unified
                  ? "text-foreground bg-card/90 shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
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
                "p-1 rounded-lg transition-colors",
                diffViewMode !== DiffModeEnum.Unified
                  ? "text-foreground bg-card/90 shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Columns2 className="w-3.5 h-3.5" />
            </TooltipTrigger>
            <TooltipContent>Split diff</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {truncationInfo && (
        <div className="flex items-start gap-2 px-3 py-2 border-b border-accent/22 bg-amber-500/5 text-amber-400 shrink-0">
          <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div className="flex flex-col gap-0.5 text-xs">
            <span className="font-medium">Diff too large, partial view</span>
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
          emptyMessage={totalFileCount === 0 && !diffError ? "No changes in this scope" : undefined}
        />
      </ReviewLayout>
    </div>
  );
}
