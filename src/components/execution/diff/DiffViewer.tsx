import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DiffViewWithMultiSelect,
  DiffModeEnum,
  SplitSide,
  type DiffViewWithMultiSelectRef,
  type LineRange,
  type MultiSelectResult,
  type MultiSelectState,
} from "@git-diff-view/react";
import {
  getDiffHighlighter,
  type DiffHighlighterInstance,
} from "@/utils/helpers/shiki-highlighter";
import "@git-diff-view/react/styles/diff-view.css";
import "./diff-expand.css";
import { DiffFile } from "@/types/review";
import { useTheme } from "@/providers/ThemeProvider";
import { cn } from "@/lib/utils.ts";
import { InlineCommentInput } from "./InlineCommentInput";
import { PendingCommentBlock } from "./PendingCommentBlock";
import { buildExtendData } from "./extend-data";
import { scopeRangeToHunk } from "./scope-selection";
import { bindHunkHeaderPress, CONTEXT_REQUEST_CLASS } from "./hunk-header-press";

export interface PendingComment {
  id: string;
  filePath: string;
  /**
   * The last line the comment covers — 0 = file-level. The end rather than the start because that
   * is the row the comment renders under, and `extendData` can only key one comment per line.
   */
  lineNumber: number;
  /** First line of a multi-line range. Absent, or equal to `lineNumber`, means a single line. */
  fromLineNumber?: number;
  side: "old" | "new";
  text: string;
}

interface DiffViewerProps {
  diffFile: DiffFile | null;
  loading: boolean;
  error?: string;
  diffViewMode?: DiffModeEnum;
  // Review mode (inline comment gutters)
  reviewMode?: boolean;
  comments?: PendingComment[];
  activeCommentLine?: { lineNumber: number; side: "old" | "new" } | null;
  /** `fromLineNumber` is the first line of a drag-selected range, or `lineNumber` for one line. */
  onAddComment?: (lineNumber: number, fromLineNumber: number, side: "old" | "new") => void;
  onRemoveComment?: (commentId: string) => void;
  onEditComment?: (commentId: string, newText: string) => void;
  onCancelComment?: () => void;
  onSubmitComment?: (text: string) => void;
  /** Send one comment on its own. Omitted where comments only leave in a batch. */
  onSendComment?: (commentId: string) => void;
  /**
   * Where this comment sits in the review's whole set, and how to step off it. Supplied by a host
   * that knows about the other files — this viewer only ever sees one — so that a comment reads the
   * same here as it does in the plan and canvas tabs.
   */
  commentNav?: (commentId: string) => {
    onPrev: () => void;
    onNext: () => void;
    position: [number, number];
  } | null;
  sendDisabled?: boolean;
  /**
   * Called when the user presses a hunk header while the file's surrounding context is not
   * loaded. Omit to leave hunk headers inert, which is what a diff whose pre-image cannot be
   * fetched — an untracked file, a rename with no old blob — should do.
   *
   * See `useHunkHeaderPress` for why this is a request rather than the expansion itself.
   */
  onRequestContext?: () => void;
  /**
   * Whether to syntax-highlight, as opposed to rendering the same diff in plain text.
   *
   * The one expensive thing this component does. Building the diff's structure is under a
   * millisecond a file; Shiki tokenising it is 25–150ms, and up to 1.8s for a large one — all of
   * it synchronous, inside `DiffView`'s effects. `@git-diff-view` keeps the two apart
   * (`DiffView.tsx:320` only calls `initSyntax` for a highlighted view) which is what lets a host
   * render a whole review at once and colour it afterwards.
   *
   * Turning it on later costs nothing but the tokenising: `DiffContent` renders the same row, the
   * same `pre-wrap`/`break-all` and the same characters either way, and only swaps the text for
   * coloured spans — inline elements that cannot change how a line wraps. So a card's height is
   * the same before and after, and a stack can promote cards without moving anything on screen.
   */
  highlight?: boolean;
}

function splitSideToSide(side: SplitSide): "old" | "new" {
  return side === SplitSide.old ? "old" : "new";
}

/**
 * A range comment renders under its last line exactly like a single-line one, so without this the
 * two are indistinguishable once the drag highlight is gone.
 */
function rangeLabel(comment: PendingComment): string | undefined {
  const { fromLineNumber, lineNumber } = comment;
  if (!fromLineNumber || fromLineNumber === lineNumber) return undefined;
  return `Lines ${Math.min(fromLineNumber, lineNumber)}–${Math.max(fromLineNumber, lineNumber)}`;
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
  reviewMode,
  comments,
  onAddComment,
  onRemoveComment,
  onEditComment,
  onCancelComment,
  onSubmitComment,
  onSendComment,
  commentNav,
  sendDisabled,
  onRequestContext,
  highlight = true,
}: DiffViewerProps) {
  const [highlighter, setHighlighter] = useState<DiffHighlighterInstance | null>(null);
  const [highlighterError, setHighlighterError] = useState<string | null>(null);
  const multiSelectRef = useRef<DiffViewWithMultiSelectRef>(null);
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

  /**
   * The range a drag actually selected, kept because pressing the `+` discards it.
   *
   * The multi-select manager starts a fresh selection from any mousedown landing inside the line
   * number cell, and the add-widget button sits in exactly that cell. Its handler calls
   * `stopPropagation`, but it is a React `onMouseDown` dispatched from the root container, so it
   * runs after the manager's own native listener further down the tree has already discarded the
   * remembered range. The widget then reports `fromLineNumber === lineNumber` and a five-line
   * selection is recorded as a comment on one line. Verified in both diff modes, and against the
   * library's own demo page — the highlight staying painted there is `clearSelection` leaving
   * preselected lines alone, not the range surviving.
   *
   * Swallowing the press instead is not an option: that same handler is what opens the composer.
   * So the range is remembered as the drag completes and re-applied when the widget is pressed on
   * its last line.
   */
  const selectionRef = useRef<{ side: "old" | "new"; from: number; to: number } | null>(null);
  /** Whether the mousedown now being processed landed on the `+` rather than on the gutter. */
  const pressedWidgetRef = useRef(false);

  /**
   * A ref callback rather than an effect: an effect keyed on `reviewMode` alone would bind against
   * whatever the wrapper was on that render, and this one is replaced as the diff is rebuilt.
   * Capture phase, so the flag is set before the manager reacts to the same press.
   */
  const bindWidgetPressFlag = useCallback(
    (wrapper: HTMLDivElement | null) => {
      if (!wrapper || !reviewMode) return;
      const notePress = (event: MouseEvent) => {
        const target = event.target;
        pressedWidgetRef.current =
          target instanceof Element && target.closest(".diff-add-widget-wrapper") !== null;
      };
      wrapper.addEventListener("mousedown", notePress, true);
      return () => wrapper.removeEventListener("mousedown", notePress, true);
    },
    [reviewMode],
  );

  /**
   * Both wrapper listeners in one ref callback, since an element takes a single ref. Each binder
   * returns its own cleanup and no-ops when its feature is off.
   */
  const bindWrapper = useCallback(
    (wrapper: HTMLDivElement | null) => {
      const unbindWidgetPress = bindWidgetPressFlag(wrapper);
      const unbindHunkPress = bindHunkHeaderPress(wrapper, onRequestContext);
      return () => {
        unbindWidgetPress?.();
        unbindHunkPress?.();
      };
    },
    [bindWidgetPressFlag, onRequestContext],
  );

  const handleMultiSelectChange = useCallback(
    (_range: LineRange | null, state: MultiSelectState) => {
      // A drag beginning anywhere but the widget supersedes whatever was selected before it.
      if (state.isSelecting && !pressedWidgetRef.current) selectionRef.current = null;
    },
    [],
  );

  const handleMultiSelectComplete = useCallback((result: MultiSelectResult) => {
    // The press on the `+` completes a one-line "selection" of its own; that is the event this
    // whole mechanism exists to ignore.
    if (pressedWidgetRef.current) return;
    const { side, startLineNumber, endLineNumber } = result.range;
    selectionRef.current = {
      side,
      from: Math.min(startLineNumber, endLineNumber),
      to: Math.max(startLineNumber, endLineNumber),
    };
  }, []);

  const extendData = useMemo(() => buildExtendData(reviewMode, comments), [reviewMode, comments]);

  const mode = diffViewMode ?? DiffModeEnum.Unified;
  // The same test the multi-select wrapper applies to pick its unified/split line lookups.
  const isUnified = !(mode & DiffModeEnum.Split);

  const scopeToHunk = useCallback(
    (range: LineRange) => {
      const instance = multiSelectRef.current?.getDiffFileInstance();
      return instance ? scopeRangeToHunk(instance, range, isUnified) : null;
    },
    [isUnified],
  );

  // Native widget callbacks
  const handleAddWidgetClick = useCallback(
    ({
      lineNumber,
      fromLineNumber,
      side,
    }: {
      lineNumber: number;
      fromLineNumber?: number;
      side: SplitSide;
    }) => {
      const commentSide = splitSideToSide(side);
      const remembered = selectionRef.current;
      const range =
        remembered && remembered.side === commentSide && remembered.to === lineNumber
          ? remembered
          : { from: fromLineNumber ?? lineNumber, to: lineNumber };
      // Put the highlight back under the composer that is about to open, since the press just
      // discarded it.
      multiSelectRef.current?.setPreselectedLines({
        old: commentSide === "old" ? [range.from, range.to] : [],
        new: commentSide === "new" ? [range.from, range.to] : [],
      });
      onAddComment?.(range.to, range.from, commentSide);
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
      const nav = commentNav?.(data.id);
      return (
        // Tagged so the host can find this comment in the DOM and scroll to it: stepping between
        // comments crosses files, and the target is inside a diff the host does not render itself.
        <div data-comment-id={data.id}>
          <PendingCommentBlock
            text={data.text}
            rangeLabel={rangeLabel(data)}
            onRemove={() => onRemoveComment(data.id)}
            onEdit={onEditComment ? (newText) => onEditComment(data.id, newText) : undefined}
            onSend={onSendComment ? () => onSendComment(data.id) : undefined}
            sendDisabled={sendDisabled}
            {...(nav ?? {})}
          />
        </div>
      );
    },
    [onRemoveComment, onEditComment, onSendComment, sendDisabled, commentNav],
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

  return (
    <div className="min-h-0 flex flex-col h-full">
      <div
        ref={bindWrapper}
        className={cn(
          "flex-1 min-h-0",
          reviewMode && "review-mode-active",
          onRequestContext && CONTEXT_REQUEST_CLASS,
        )}
      >
        {/* Multi-select is review-only: a read-only diff has nothing to do with a selection, and
            leaving it on there would highlight lines the user cannot act on. */}
        <DiffViewWithMultiSelect
          ref={multiSelectRef}
          data={diffFile}
          diffViewMode={mode}
          diffViewTheme={diffTheme}
          // Also gated on the highlighter itself: it loads asynchronously, and `initSyntax` with
          // nothing registered is not a diff without colour, it is a broken one. Waiting for it
          // behind a placeholder — which is what this used to do — would have meant the diff
          // appearing at one height and then jumping to another.
          diffViewHighlight={highlight && highlighter !== null}
          diffViewWrap
          registerHighlighter={highlighter as any}
          enableMultiSelect={!!reviewMode}
          scopeMultiSelectToHunk={scopeToHunk}
          onMultiSelectChange={handleMultiSelectChange}
          onMultiSelectComplete={handleMultiSelectComplete}
          diffViewAddWidget={reviewMode}
          onAddWidgetClick={reviewMode ? handleAddWidgetClick : undefined}
          renderWidgetLine={reviewMode ? renderWidgetLine : undefined}
          extendData={extendData}
          renderExtendLine={reviewMode ? renderExtendLine : undefined}
        />
      </div>
    </div>
  );
}
