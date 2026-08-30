import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { DiffModeEnum } from "@git-diff-view/react";
import { type PendingComment } from "./DiffViewer";
import { ExpandableDiffViewer } from "./ExpandableDiffViewer";
import { UntrackedFileDiffViewer } from "./UntrackedFileDiffViewer";
import { ReviewFileCard, fileNote } from "./ReviewFileCard";
import { useCommentNavigation } from "./useCommentNavigation";
import { LoadDiffPrompt } from "./LoadDiffPrompt";
import { diffLineCount, planEagerBodies, UNKNOWN_FILE_LINES } from "./body-budget";
import { displayItemPath, type DisplayItem } from "@/types/review";
import type { DiffTarget } from "@/types/bindings";

/**
 * Where a stack's comments live, as intents.
 *
 * Task review writes into `reviewStore` and sends them as one Rework payload; the session panel
 * writes into `annotationStore` and can send them one at a time. Keeping this an interface is what
 * lets the two keep their own stores — and their own meaning — while the interaction stays one
 * implementation.
 */
export interface DiffReviewApi {
  /** Every pending comment in the review, across all files. */
  comments: PendingComment[];
  /**
   * Create or replace. `lineNumber` 0 is the file's own note; otherwise it is the *last* line
   * covered, with `fromLineNumber` the first — equal to it for a comment on a single line.
   */
  onSubmitComment: (
    filePath: string,
    lineNumber: number,
    fromLineNumber: number,
    side: "old" | "new",
    text: string,
  ) => void;
  onRemoveComment: (id: string) => void;
  onEditComment: (id: string, text: string) => void;
  /** Omitted where comments only leave in a batch, which removes the per-comment send button. */
  onSendComment?: (id: string) => void;
  sendDisabled?: boolean;
}

/** Module-level so a review-less stack does not hand the comment hooks a new array each render. */
const EMPTY_COMMENTS: PendingComment[] = [];

/** A drift smaller than this counts as arrived, in pixels. */
const SETTLE_TOLERANCE = 1;
/** How many consecutive still frames end the settle loop. */
const SETTLE_STABLE_FRAMES = 3;
/** Upper bound on the settle loop, in frames — roughly a second and a half at 60fps. */
const SETTLE_MAX_FRAMES = 90;

export interface DiffFileStackHandle {
  /** Expand the file at `index`, scroll it to the top of the stack, and select it. */
  navigateTo: (index: number) => void;
}

interface DiffFileStackProps {
  items: DisplayItem[];
  projectId: number | null;
  /** The worktree the diff was taken in — where untracked file contents are read from. */
  cwd: string | null;
  /**
   * What the diff compares against. Needed beyond fetching the diff itself because expanding a
   * hunk reads the file's pre-image, which only exists at this target's base revision.
   */
  diffTarget: DiffTarget;
  diffViewMode: DiffModeEnum;
  /**
   * The card the reader picked, or null for none. A stack opens unselected: nothing has been
   * chosen yet, and highlighting the first file claims otherwise.
   */
  selectedIndex: number | null;
  onSelectedIndexChange: (index: number) => void;
  viewedFiles: Set<string>;
  onToggleViewed: (path: string) => void;
  /**
   * Where remarks on this diff go. Omitted ⇒ the stack is read-only: no comment gutter, no card
   * comment button, no navigation between comments. The worktree view reads a diff with nobody to
   * address, which is not the same as a review with nothing written in it yet.
   */
  review?: DiffReviewApi;
  /** Omitted ⇒ file names are not links. Called with the path as the host wants to receive it. */
  onOpenFile?: (path: string) => void;
  /**
   * Called before revealing a file, so a host that hides files behind a filter can put this one
   * back in the list. Without it a comment on a filtered-out file cannot be stepped to.
   */
  onBeforeReveal?: (path: string) => void;
  loading?: boolean;
  /** Shown when there is nothing to list. Omit to show nothing — e.g. while an error is up. */
  emptyMessage?: string;
  ref?: React.Ref<DiffFileStackHandle>;
}

/**
 * A review's files as a scrolling stack of cards.
 *
 * Shared by the session panel's Changes tab and task review. `navigateTo` scrolls to a file and
 * selects it, so a host can drive it from a sidebar, a pair of chevrons, or a file picker and get
 * the same behaviour from each. Scrolling changes nothing: the selection is whatever was last
 * picked, not wherever the viewport happens to be.
 */
export function DiffFileStack({
  items,
  projectId,
  cwd,
  diffTarget,
  diffViewMode,
  selectedIndex,
  onSelectedIndexChange,
  viewedFiles,
  onToggleViewed,
  review,
  onOpenFile,
  onBeforeReveal,
  loading,
  emptyMessage,
  ref,
}: DiffFileStackProps) {
  // Collapsed rather than expanded, so a file the user has never seen — a new scope, a new poll —
  // is open by construction. Tracking the opposite meant any file absent from the set rendered
  // shut, which is what made changing scope produce a stack of closed cards.
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  // Which line is currently taking a new comment. The stack renders one DiffViewer per file, so
  // the file has to be part of the key.
  const [activeCommentLine, setActiveCommentLine] = useState<{
    filePath: string;
    lineNumber: number;
    fromLineNumber: number;
    side: "old" | "new";
  } | null>(null);
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const settleFrameRef = useRef<number | null>(null);

  /**
   * Which files render their diff without being asked, and which the user has since asked for.
   *
   * Everything within the review's budget is built from the first frame — the document reaches its
   * true height immediately and never changes it, which is what makes `navigateTo` land exactly.
   * Beyond the budget a card shows a button instead, and nothing about that is driven by scrolling:
   * an attempt at building bodies as the viewport reached them made every scroll compete with tens
   * of milliseconds of layout, and felt considerably worse than paying the whole cost up front.
   *
   * An untracked file is counted at a nominal size here because its body is fetched rather than
   * derived from the diff, so nothing knows how big it is yet. `UntrackedFileDiffViewer` applies
   * the per-file cap itself once the content arrives.
   */
  const eagerBodies = useMemo(
    () =>
      planEagerBodies(
        items.map((item) => ({
          path: displayItemPath(item),
          lines: item.kind === "diff" ? diffLineCount(item.file.hunks) : UNKNOWN_FILE_LINES,
        })),
      ),
    [items],
  );
  const [requestedBodies, setRequestedBodies] = useState<Set<string>>(new Set());
  const requestBody = useCallback((path: string) => {
    setRequestedBodies((prev) => (prev.has(path) ? prev : new Set([...prev, path])));
  }, []);

  /**
   * Which files are syntax-highlighted.
   *
   * The other half of the cost, and the half that is free to defer: colour changes no layout at
   * all (see the `highlight` prop on `DiffViewer`), so it can arrive whenever without moving
   * anything. A body cannot, which is why that one is decided up front by the budget rather than
   * drip-fed as the reader arrives.
   */
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  /** Queued for colour, oldest first — drained one a frame so a burst cannot block a scroll. */
  const pendingHighlightRef = useRef<Set<string>>(new Set());
  const highlightFrameRef = useRef<number | null>(null);

  const toggleExpanded = useCallback((key: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * Colour one queued file per frame until the queue is empty.
   *
   * One at a time rather than one batch: the tokenising is synchronous inside `DiffView`'s
   * effects, so a commit that starts four cards blocks for the sum of all four and paints nothing
   * until the last finishes. Spreading them lets the browser draw in between, which is the
   * difference between a stack that colours in and one that hitches.
   */
  const scheduleHighlight = useCallback(() => {
    if (highlightFrameRef.current !== null) return;
    const step = () => {
      const [path] = pendingHighlightRef.current;
      if (path === undefined) {
        highlightFrameRef.current = null;
        return;
      }
      pendingHighlightRef.current.delete(path);
      setHighlighted((prev) => (prev.has(path) ? prev : new Set([...prev, path])));
      highlightFrameRef.current = requestAnimationFrame(step);
    };
    highlightFrameRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(
    () => () => {
      if (highlightFrameRef.current !== null) cancelAnimationFrame(highlightFrameRef.current);
      // Cleared as well as cancelled: a handle left set reads as "a frame is already booked", and
      // StrictMode tears effects down and runs them again on the same instance.
      highlightFrameRef.current = null;
    },
    [],
  );

  /**
   * Put `path` at the top of the scroller and hold it there while the stack settles.
   *
   * Now that every diff renders at once, the layout a jump is computed against is the layout it
   * lands in, and this arrives on its first frame and stops. What it still covers is the short
   * window after a jump in which the stack can move under it: an untracked file's body is fetched
   * rather than derived from the diff, so those cards are the one height here that is not known up
   * front, and one of them resolving above the target would otherwise leave the jump short.
   *
   * It is deliberately a short window, not a guarantee — it gives up after three still frames, so
   * a fetch that lands later than that is not caught here. What holds the position then is the
   * browser's own scroll anchoring, which is also why nothing tries to fight it: a manual
   * correction on top of `overflow-anchor` is two adjustments for one shift.
   *
   * The loop yields the moment the scroll position is somewhere it did not put it, so a user who
   * scrolls while it is still correcting is not fought for the next second.
   */
  const scrollToTop = useCallback((path: string) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (settleFrameRef.current !== null) cancelAnimationFrame(settleFrameRef.current);

    let stableFrames = 0;
    let frames = 0;
    let expected = container.scrollTop;

    const finish = () => {
      settleFrameRef.current = null;
    };

    const step = () => {
      const element = sectionRefs.current.get(path);
      if (!element || Math.abs(container.scrollTop - expected) > SETTLE_TOLERANCE) return finish();

      const drift = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
      if (Math.abs(drift) > SETTLE_TOLERANCE) {
        container.scrollTop += drift;
        stableFrames = 0;
      } else {
        stableFrames += 1;
      }
      expected = container.scrollTop;
      frames += 1;
      if (stableFrames >= SETTLE_STABLE_FRAMES || frames >= SETTLE_MAX_FRAMES) return finish();
      settleFrameRef.current = requestAnimationFrame(step);
    };

    settleFrameRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(
    () => () => {
      if (settleFrameRef.current !== null) cancelAnimationFrame(settleFrameRef.current);
    },
    [],
  );

  /**
   * Put a file on screen, by path rather than by index: the host may be about to add it back to
   * a filtered list, in which case it has no index yet but its collapsed state and its section can
   * both be addressed by path already.
   *
   * Un-collapsing is the only thing this has to force. A file's diff is already in the document
   * whether or not anyone has scrolled near it, so comment navigation — which waits on a
   * MutationObserver for the comment's node and gives up after a couple of seconds — finds its
   * target without the stack having to build anything first.
   */
  const revealFile = useCallback(
    (path: string) => {
      onBeforeReveal?.(path);
      setCollapsedFiles((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      // Navigating to a file is asking for it. Comment navigation waits on a MutationObserver for
      // the comment's node and gives up after a couple of seconds, so a target still showing its
      // button would leave the chevron doing nothing at all.
      requestBody(path);
      // Ahead of the queue: this is the file the user asked for, and it is one card's worth of
      // work. Whatever was waiting can wait a frame longer.
      pendingHighlightRef.current.delete(path);
      setHighlighted((prev) => (prev.has(path) ? prev : new Set([...prev, path])));
      scrollToTop(path);
    },
    [onBeforeReveal, scrollToTop, requestBody],
  );

  const navigateTo = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      onSelectedIndexChange(index);
      revealFile(displayItemPath(item));
    },
    [items, onSelectedIndexChange, revealFile],
  );

  useImperativeHandle(ref, () => ({ navigateTo }), [navigateTo]);

  /**
   * One observer for the whole stack, watching the card elements `sectionRefs` already holds.
   *
   * Rooted at the scroller rather than the viewport, which also means a hidden session — the agent
   * monitor keeps them all mounted — has a zero-size root, so nothing intersects and nothing is
   * highlighted until it is actually looked at.
   *
   * The margin can be generous in both directions now that what it gates is colour: promoting a
   * card changes nothing about its size, so reading ahead costs work but can never move the page.
   * It was asymmetric when this gated mounting, because growth above the viewport was a shove and
   * growth below was free.
   *
   * Colour is never taken back. A file the user has scrolled past stays highlighted, so returning
   * to it costs nothing and no card is ever seen to lose its colour.
   */
  const observerRef = useRef<IntersectionObserver | null>(null);
  const pathByElement = useRef(new WeakMap<Element, string>());
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        let queued = false;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const path = pathByElement.current.get(entry.target);
          if (path === undefined) continue;
          pendingHighlightRef.current.add(path);
          queued = true;
        }
        if (queued) scheduleHighlight();
      },
      { root, rootMargin: "600px 0px 600px 0px" },
    );
    observerRef.current = observer;
    for (const element of sectionRefs.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [scheduleHighlight]);

  const registerSection = useCallback((key: string, element: HTMLElement | null) => {
    const previous = sectionRefs.current.get(key);
    if (previous && previous !== element) observerRef.current?.unobserve(previous);
    if (element) {
      sectionRefs.current.set(key, element);
      pathByElement.current.set(element, key);
      observerRef.current?.observe(element);
    } else {
      sectionRefs.current.delete(key);
    }
  }, []);

  /*
   * Scrolling does not change the selection.
   *
   * A scroll spy used to move it to whichever card sat under the top of the viewport, which meant
   * the sidebar highlight wandered while you read and the stack had to distinguish its own scrolls
   * from the user's to avoid arguing with itself. Selection is now only ever what someone picked:
   * a click in the tree, or a step between comments. It stays there until they pick something else.
   */

  const comments = review?.comments ?? EMPTY_COMMENTS;
  const { commentNav } = useCommentNavigation({
    comments,
    fileOrder: items.map(displayItemPath),
    revealFile,
    container: scrollContainerRef,
  });

  const onSubmitComment = review?.onSubmitComment;
  const onRemoveComment = review?.onRemoveComment;
  const onEditComment = review?.onEditComment;
  const onSendComment = review?.onSendComment;
  const sendDisabled = review?.sendDisabled;

  /**
   * Review-mode wiring shared by DiffViewer and UntrackedFileDiffViewer, per file. Empty without a
   * `review`, which leaves `reviewMode` off and the diff a plain read.
   */
  const reviewProps = useCallback(
    (filePath: string) => {
      if (!onSubmitComment || !onRemoveComment || !onEditComment) return {};
      return {
        reviewMode: true,
        comments: comments.filter((c) => c.filePath === filePath && c.lineNumber !== 0),
        onAddComment: (lineNumber: number, fromLineNumber: number, side: "old" | "new") =>
          setActiveCommentLine({ filePath, lineNumber, fromLineNumber, side }),
        onCancelComment: () => setActiveCommentLine(null),
        onSubmitComment: (text: string) => {
          const line = activeCommentLine;
          if (!line || line.filePath !== filePath) return;
          onSubmitComment(filePath, line.lineNumber, line.fromLineNumber, line.side, text);
          setActiveCommentLine(null);
        },
        onRemoveComment,
        onEditComment,
        onSendComment,
        commentNav,
        sendDisabled,
      };
    },
    [
      comments,
      activeCommentLine,
      onSubmitComment,
      onRemoveComment,
      onEditComment,
      onSendComment,
      sendDisabled,
      commentNav,
    ],
  );

  const fileCommentFor = useCallback(
    (filePath: string) => {
      if (!onSubmitComment || !onRemoveComment) return undefined;
      const comment = comments.find((c) => c.filePath === filePath && c.lineNumber === 0) ?? null;
      return {
        comment: comment ? { id: comment.id, text: comment.text } : null,
        onSubmit: (text: string) => onSubmitComment(filePath, 0, 0, "new", text),
        onRemove: () => comment && onRemoveComment(comment.id),
        onSend: onSendComment && comment ? () => onSendComment(comment.id) : undefined,
        sendDisabled,
        nav: comment ? commentNav(comment.id) : null,
      };
    },
    [comments, onSubmitComment, onRemoveComment, onSendComment, sendDisabled, commentNav],
  );

  return (
    <div
      ref={scrollContainerRef}
      className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 pb-3 flex flex-col"
    >
      {loading && (
        <div className="text-xs text-muted-foreground py-8 text-center animate-pulse">
          Loading...
        </div>
      )}
      {!loading && items.length === 0 && emptyMessage && (
        <div className="text-xs text-muted-foreground py-8 text-center">{emptyMessage}</div>
      )}
      {!loading &&
        items.map((item, index) => {
          const key = displayItemPath(item);
          const hunks = item.kind === "diff" ? item.file.hunks : [];
          return (
            <ReviewFileCard
              key={key}
              ref={(el) => registerSection(key, el)}
              path={key}
              hunks={hunks}
              viewed={viewedFiles.has(key)}
              onToggleViewed={() => onToggleViewed(key)}
              expanded={!collapsedFiles.has(key)}
              onToggleExpanded={() => toggleExpanded(key)}
              focused={index === selectedIndex}
              onOpenFile={onOpenFile ? () => onOpenFile(key) : undefined}
              note={item.kind === "diff" ? fileNote(item.file) : undefined}
              fileComment={fileCommentFor(key)}
            >
              {!(eagerBodies.has(key) || requestedBodies.has(key)) ? (
                <LoadDiffPrompt lines={diffLineCount(hunks)} onLoad={() => requestBody(key)} />
              ) : item.kind === "diff" ? (
                <ExpandableDiffViewer
                  file={item.file}
                  projectId={projectId}
                  cwd={cwd}
                  diffTarget={diffTarget}
                  diffViewMode={diffViewMode}
                  highlight={highlighted.has(key)}
                  {...reviewProps(key)}
                />
              ) : (
                <UntrackedFileDiffViewer
                  projectId={projectId}
                  worktreePath={cwd}
                  filePath={item.path}
                  showHeader={false}
                  highlight={highlighted.has(key)}
                  {...reviewProps(key)}
                />
              )}
            </ReviewFileCard>
          );
        })}
    </div>
  );
}
