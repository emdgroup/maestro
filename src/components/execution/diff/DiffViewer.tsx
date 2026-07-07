import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DiffView, DiffModeEnum, SplitSide } from "@git-diff-view/react";
import {
  getDiffHighlighter,
  type DiffHighlighterInstance,
} from "@/utils/helpers/shiki-highlighter";
import "@git-diff-view/react/styles/diff-view.css";
import "./diff-viewer-overrides.css";
import { DiffFile } from "@/types/review";
import { useTheme } from "@/providers/ThemeProvider";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { InlineCommentInput } from "./InlineCommentInput";
import { PendingCommentBlock } from "./PendingCommentBlock";

export interface PendingComment {
  id: string;
  filePath: string;
  lineNumber: number; // 0 = file-level
  side: "old" | "new";
  text: string;
}

interface DiffViewerProps {
  diffFile: DiffFile | null;
  loading: boolean;
  error?: string;
  diffViewMode?: DiffModeEnum;
  // Hunk selection support
  hunkSelection?: Set<number>;
  onHunkToggle?: (hunkIndex: number) => void;
  // Review mode (inline comment gutters)
  reviewMode?: boolean;
  comments?: PendingComment[];
  activeCommentLine?: { lineNumber: number; side: "old" | "new" } | null;
  onAddComment?: (lineNumber: number, side: "old" | "new") => void;
  onRemoveComment?: (commentId: string) => void;
  onEditComment?: (commentId: string, newText: string) => void;
  onCancelComment?: () => void;
  onSubmitComment?: (text: string) => void;
}

function splitSideToSide(side: SplitSide): "old" | "new" {
  return side === SplitSide.old ? "old" : "new";
}

function HunkCheckboxOverlay({
  wrapperRef,
  hunkSelection,
  onHunkToggle,
}: {
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  hunkSelection?: Set<number>;
  onHunkToggle: (idx: number) => void;
}) {
  const [hunkCells, setHunkCells] = useState<HTMLElement[]>([]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const syncCells = () => {
      const cells = Array.from(wrapper.querySelectorAll<HTMLElement>("td.diff-line-hunk-action"));
      setHunkCells(cells);
    };

    syncCells();

    const observer = new MutationObserver(syncCells);
    observer.observe(wrapper, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [wrapperRef]);

  return (
    <>
      {hunkCells.map((cell, idx) =>
        createPortal(
          <CheckboxPrimitive.Root
            checked={hunkSelection?.has(idx) ?? false}
            onCheckedChange={() => onHunkToggle(idx)}
            onClick={(e) => e.stopPropagation()}
            className="hunk-checkbox border-border dark:bg-input/30 data-checked:bg-accent dark:data-checked:bg-accent data-checked:text-accent-foreground data-checked:border-accent flex size-4.5 items-center justify-center rounded-[4px] border shadow-xs shrink-0 outline-none"
            tabIndex={-1}
          >
            <CheckboxPrimitive.Indicator className="[&>svg]:size-3.5 grid place-content-center text-accent-foreground">
              <Check className="size-3.5" />
            </CheckboxPrimitive.Indicator>
          </CheckboxPrimitive.Root>,
          cell,
        ),
      )}
    </>
  );
}

const DiffPlaceholder = ({
  message,
  variant = "muted",
}: {
  message: string;
  variant?: "muted" | "error";
}) => (
  <div
    className={`flex items-center justify-center h-full text-sm ${variant === "error" ? "text-destructive" : "text-muted-foreground"}`}
  >
    {message}
  </div>
);

export function DiffViewer({
  diffFile,
  loading,
  error,
  diffViewMode,
  hunkSelection,
  onHunkToggle,
  reviewMode,
  comments,
  onAddComment,
  onRemoveComment,
  onEditComment,
  onCancelComment,
  onSubmitComment,
}: DiffViewerProps) {
  const [highlighter, setHighlighter] = useState<DiffHighlighterInstance | null>(null);
  const [highlighterError, setHighlighterError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { theme, systemTheme } = useTheme();
  const diffTheme = (theme === "system" ? systemTheme : theme) === "dark" ? "dark" : "light";

  // Load syntax highlighter on mount
  useEffect(() => {
    const loadHighlighter = async () => {
      try {
        const hl = await getDiffHighlighter();
        setHighlighter(hl);
      } catch (err) {
        console.error("Failed to load highlighter:", err);
        setHighlighterError(
          err instanceof Error ? err.message : "Failed to load syntax highlighter",
        );
      }
    };

    loadHighlighter();
  }, []);

  // Build extendData from comments (single comment per line/side)
  const extendData = useMemo(() => {
    if (!reviewMode || !comments || comments.length === 0) return undefined;
    const oldFile: Record<string, { data: PendingComment }> = {};
    const newFile: Record<string, { data: PendingComment }> = {};
    for (const comment of comments) {
      if (comment.lineNumber === 0) continue;
      const key = String(comment.lineNumber);
      const target = comment.side === "old" ? oldFile : newFile;
      target[key] = { data: comment };
    }
    return { oldFile, newFile };
  }, [reviewMode, comments]);

  // Native widget callbacks
  const handleAddWidgetClick = useCallback(
    (lineNumber: number, side: SplitSide) => {
      onAddComment?.(lineNumber, splitSideToSide(side));
    },
    [onAddComment],
  );

  const renderWidgetLine = useCallback(
    ({ onClose }: { lineNumber: number; side: SplitSide; diffFile: any; onClose: () => void }) => {
      if (!onSubmitComment || !onCancelComment) return null;
      return (
        <InlineCommentInput
          onSubmit={(text) => {
            onSubmitComment(text);
            onClose();
          }}
          onCancel={() => {
            onCancelComment();
            onClose();
          }}
        />
      );
    },
    [onSubmitComment, onCancelComment],
  );

  const renderExtendLine = useCallback(
    ({
      data,
    }: {
      lineNumber: number;
      side: SplitSide;
      data: PendingComment;
      diffFile: any;
      onUpdate: () => void;
    }) => {
      if (!onRemoveComment) return null;
      return (
        <PendingCommentBlock
          text={data.text}
          onRemove={() => onRemoveComment(data.id)}
          onEdit={onEditComment ? (newText) => onEditComment(data.id, newText) : undefined}
        />
      );
    },
    [onRemoveComment, onEditComment],
  );

  if (highlighterError)
    return (
      <DiffPlaceholder
        message={`Error loading syntax highlighter: ${highlighterError}`}
        variant="error"
      />
    );
  if (loading) return <DiffPlaceholder message="Loading diff..." />;
  if (error) return <DiffPlaceholder message={`Error loading diff: ${error}`} variant="error" />;
  if (!diffFile) return <DiffPlaceholder message="No changes to display" />;
  if (!highlighter) return <DiffPlaceholder message="Initializing syntax highlighter..." />;

  return (
    <div className="min-h-0 flex flex-col h-full">
      <div
        ref={wrapperRef}
        className={cn(
          "flex-1 min-h-0",
          onHunkToggle && "hunk-selection-active",
          reviewMode && "review-mode-active",
        )}
      >
        <DiffView
          data={diffFile}
          diffViewMode={diffViewMode ?? DiffModeEnum.Unified}
          diffViewTheme={diffTheme}
          diffViewHighlight
          diffViewWrap
          registerHighlighter={highlighter as any}
          diffViewAddWidget={reviewMode}
          onAddWidgetClick={reviewMode ? handleAddWidgetClick : undefined}
          renderWidgetLine={reviewMode ? renderWidgetLine : undefined}
          extendData={extendData}
          renderExtendLine={reviewMode ? renderExtendLine : undefined}
        />
        {onHunkToggle && (
          <HunkCheckboxOverlay
            wrapperRef={wrapperRef}
            hunkSelection={hunkSelection}
            onHunkToggle={onHunkToggle}
          />
        )}
      </div>
    </div>
  );
}
