import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { DiffModeEnum } from "@git-diff-view/react";
import { useReviewChangesData } from "./useReviewChangesData";
import { ReviewChangesPanelCompact } from "./ReviewChangesPanelCompact";

interface ReviewChangesPanelProps {
  sessionKey: number;
  sessionChangedFiles: string[];
  onClose: () => void;
  initialFile?: string;
  compact?: boolean;
  isActive?: boolean;
  onDiffStats?: (stats: { insertions: number; deletions: number } | null) => void;
}

export function ReviewChangesPanel({
  sessionKey,
  sessionChangedFiles,
  initialFile,
  compact = false,
  isActive = true,
  onDiffStats,
}: ReviewChangesPanelProps) {
  const [diffViewMode, setDiffViewMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());
  const [listOpen, setListOpen] = useState(false);
  const initialFileAppliedRef = useRef(false);

  const toggleViewed = useCallback((fileName: string) => {
    setViewedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });
  }, []);

  const { projectId, cwd, allDisplayItems, loading, totalFileCount, diffError, truncationInfo } =
    useReviewChangesData({ sessionKey, sessionChangedFiles, isActive, onDiffStats });

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
        allDisplayItems={allDisplayItems}
        loading={loading}
        totalFileCount={totalFileCount}
        diffError={diffError}
        projectId={projectId}
        cwd={cwd}
        truncationInfo={truncationInfo}
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
      />
    );
  }

  return null;
}
