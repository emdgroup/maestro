import { useState, useMemo, useCallback } from "react";
import { DiffModeEnum } from "@git-diff-view/react";
import { useReviewChangesData } from "./useReviewChangesData";
import { ReviewChangesPanelCompact } from "./ReviewChangesPanelCompact";
import type { Annotation } from "@/store/annotationStore";

interface ReviewChangesPanelProps {
  sessionKey: number;
  onClose: () => void;
  initialFile?: string;
  compact?: boolean;
  isActive?: boolean;
  onDiffStats?: (stats: { insertions: number; deletions: number } | null) => void;
  onSendAnnotations: (annotations: Annotation[]) => void;
  annotationSendDisabled?: boolean;
  /** Opens a path (absolute, or project-relative) in a Files tab. */
  onOpenFile?: (path: string) => void;
}

export function ReviewChangesPanel({
  sessionKey,
  initialFile,
  compact = false,
  isActive = true,
  onDiffStats,
  onSendAnnotations,
  annotationSendDisabled,
  onOpenFile,
}: ReviewChangesPanelProps) {
  const [diffViewMode, setDiffViewMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());
  const [listOpen, setListOpen] = useState(false);

  const toggleViewed = useCallback((fileName: string) => {
    setViewedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });
  }, []);

  const {
    projectId,
    cwd,
    allDisplayItems,
    loading,
    totalFileCount,
    diffError,
    truncationInfo,
    scope,
  } = useReviewChangesData({ sessionKey, isActive, onDiffStats });

  // The caller's requested file can only be resolved once the async diff has arrived, and
  // must be applied exactly once so it never overrides a later click. Both are expressed
  // during render — the one-shot flag is state rather than a ref so the read stays pure.
  const initialFileIndex = initialFile
    ? allDisplayItems.findIndex((item) =>
        item.kind === "diff"
          ? initialFile.endsWith(item.file.fileName)
          : item.path.endsWith(initialFile),
      )
    : -1;
  const [initialFileApplied, setInitialFileApplied] = useState(false);
  if (!initialFileApplied && initialFileIndex >= 0) {
    setInitialFileApplied(true);
    setSelectedFileIndex(initialFileIndex);
  }

  const fileSelectorFiles = useMemo(
    () =>
      allDisplayItems.map((item) => ({
        fileName: item.kind === "diff" ? item.file.fileName : item.path,
        status: item.kind === "diff" ? (item.file.status ?? ("M" as const)) : ("A" as const),
      })),
    [allDisplayItems],
  );

  const focusedItem = allDisplayItems[selectedFileIndex] ?? null;
  const focusedKey = focusedItem
    ? focusedItem.kind === "diff"
      ? focusedItem.file.fileName
      : focusedItem.path
    : null;
  const focusedBasename = focusedKey ? (focusedKey.split("/").pop() ?? focusedKey) : null;

  if (compact) {
    return (
      <ReviewChangesPanelCompact
        sessionKey={sessionKey}
        onSendAnnotations={onSendAnnotations}
        annotationSendDisabled={annotationSendDisabled}
        allDisplayItems={allDisplayItems}
        loading={loading}
        totalFileCount={totalFileCount}
        diffError={diffError}
        projectId={projectId}
        cwd={cwd}
        truncationInfo={truncationInfo}
        scope={scope}
        diffViewMode={diffViewMode}
        setDiffViewMode={setDiffViewMode}
        selectedFileIndex={selectedFileIndex}
        setSelectedFileIndex={setSelectedFileIndex}
        viewedFiles={viewedFiles}
        toggleViewed={toggleViewed}
        listOpen={listOpen}
        setListOpen={setListOpen}
        fileSelectorFiles={fileSelectorFiles}
        focusedKey={focusedKey}
        focusedBasename={focusedBasename}
        onOpenFile={onOpenFile}
      />
    );
  }

  return null;
}
