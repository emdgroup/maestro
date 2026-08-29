import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { DiffModeEnum } from "@git-diff-view/react";
import { type PendingComment } from "./DiffViewer";
import { ExpandableDiffViewer } from "./ExpandableDiffViewer";
import { UntrackedFileDiffViewer } from "./UntrackedFileDiffViewer";
import { ReviewFileCard, fileNote } from "./ReviewFileCard";
import { useCommentNavigation } from "./useCommentNavigation";
import {
  activeIndexAt,
  BODY_MARGIN_PX,
  SETTLE_MAX_FRAMES,
  SETTLE_STABLE_FRAMES,
  SETTLE_TOLERANCE,
  SNAP_TOLERANCE,
} from "./stack-scroll";
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

/**
 * Where an element sits in the scroller's content, in the same space as `scrollTop`.
 *
 * Not `offsetTop`, which is measured from the nearest *positioned* ancestor — `ReviewLayout`'s
 * container rather than the scroller inside it — and so carries the diff surface's inset as a
 * constant error.
 */
function contentOffsetOf(element: HTMLElement, container: HTMLElement): number {
  return (
    element.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop
  );
}

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
  selectedIndex: number;
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
 * Shared by the session panel's Changes tab and task review. Scrolling selects the file under the
 * top of the viewport, and `navigateTo` scrolls to one — so a host can drive it from a sidebar, a
 * pair of chevrons, or a file picker, and get the same behaviour from each.
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
  const programmaticScrollRef = useRef(false);
  const settleFrameRef = useRef<number | null>(null);

  /**
   * Whose diff body is built. Every file's *header* is always rendered, which is what keeps this
   * honest: the stack is a complete skeleton whose every offset is real, so the scroll spy and
   * `navigateTo` work against measured positions rather than guesses about files they have never
   * seen. A body that has not been built contributes nothing to the document — not an estimate, a
   * fact about the page as it currently stands.
   *
   * So the document only ever grows, and only in front of the reader. That is the property the
   * previous designs lacked: they reserved a guessed height and then corrected it, which is a
   * change to a part of the page the user may be looking at.
   */
  const [loadedBodies, setLoadedBodies] = useState<Set<string>>(new Set());
  /**
   * The same set, readable synchronously.
   *
   * Load requests arrive from an observer callback, and several can land before React commits any
   * of them. Deciding what is new against the rendered state would let the same file be counted as
   * new twice — which matters because "something new is being added" is what arms the scroll
   * correction below, and arming it for a change that never happens leaves a stale anchor to be
   * applied against a scroll position it knows nothing about.
   */
  const loadedBodiesRef = useRef<Set<string>>(new Set());
  /**
   * Where the topmost on-screen card sat before a body was added, so the scroll position can be
   * put back afterwards.
   *
   * Only bodies loading *above* the viewport need this, which happens when scrolling up into
   * files never visited. Captured before the state change, while the DOM still shows the old
   * layout, and applied in a layout effect after the new one — so the correction lands in the same
   * frame and nothing is seen to move.
   */
  const shiftAnchorRef = useRef<{ path: string; offset: number } | null>(null);

  /**
   * Which files are syntax-highlighted.
   *
   * The second of the two costs, and the one that is free to be lazy: colour changes no layout at
   * all (see the `highlight` prop on `DiffViewer`), so it can arrive whenever without moving
   * anything. A body cannot — hence `loadedBodies` above, which is the same idea applied to a cost
   * that does move the page and therefore has to be paid in front of the reader rather than behind
   * them.
   */
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  /** Queued for colour, oldest first — drained one a frame so a burst cannot block a scroll. */
  const pendingHighlightRef = useRef<Set<string>>(new Set());
  const highlightFrameRef = useRef<number | null>(null);
  /**
   * Queued to be built, and re-checked against the layout as it stands when each one comes up.
   *
   * A stack of nothing but headers is dense: at mount, eighty of them fit inside the margin, and
   * taking the observer at its word built forty-two bodies — 166ms to first paint followed by a
   * second and a half of work nobody asked for. The first few bodies push the rest out of range,
   * so draining slowly and re-testing turns that into a handful. It does the same for a fast
   * scroll, where most of what was reported has already gone by.
   */
  const pendingBodiesRef = useRef<Set<string>>(new Set());
  const bodyFrameRef = useRef<number | null>(null);

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
  /**
   * Remember where the topmost on-screen card is, before anything is added to the document.
   *
   * The first card at or below the scroller's top edge, because that is the one the reader is
   * looking at and the one a body loading above it would push down. Cheap enough to do on every
   * load: one rect per rendered header, and headers are all that exist for most of the stack.
   */
  const captureShiftAnchor = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || shiftAnchorRef.current) return;
    const containerTop = container.getBoundingClientRect().top;
    let anchor: { path: string; offset: number } | null = null;
    let best = Infinity;
    for (const [path, element] of sectionRefs.current) {
      const top = element.getBoundingClientRect().top;
      if (top < containerTop - SNAP_TOLERANCE || top >= best) continue;
      best = top;
      // Content offset, not viewport position: `scrollTop` can move between capture and use —
      // the settle loop after a jump does exactly that — and a viewport-relative anchor would
      // then read that scroll as content having shifted and undo it.
      anchor = { path, offset: contentOffsetOf(element, container) };
    }
    shiftAnchorRef.current = anchor;
  }, []);

  /** Build these bodies, keeping whatever is on screen where it is. Already-built paths are free. */
  const loadBodies = useCallback(
    (paths: string[]) => {
      const fresh = paths.filter((path) => !loadedBodiesRef.current.has(path));
      if (fresh.length === 0) return;
      // Before the state change, while the DOM still shows the layout these are about to alter.
      captureShiftAnchor();
      const next = new Set(loadedBodiesRef.current);
      for (const path of fresh) next.add(path);
      loadedBodiesRef.current = next;
      setLoadedBodies(next);
    },
    [captureShiftAnchor],
  );

  // Put it back. `overflow-anchor: none` on the scroller leaves this as the only thing adjusting
  // the position — the browser's own scroll anchoring would otherwise correct the same shift and
  // the two would add up.
  useLayoutEffect(() => {
    const anchor = shiftAnchorRef.current;
    shiftAnchorRef.current = null;
    const container = scrollContainerRef.current;
    if (!anchor || !container) return;
    const element = sectionRefs.current.get(anchor.path);
    if (!element) return;
    const drift = contentOffsetOf(element, container) - anchor.offset;
    if (Math.abs(drift) > SNAP_TOLERANCE) container.scrollTop += drift;
  }, [loadedBodies]);

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
   * Build one queued body a frame, skipping any that the layout has since carried out of range.
   *
   * A body is ~35ms of blocked main thread, so one per frame is the most that can be spent without
   * the stack feeling like it stalls. Colour is queued behind its own body rather than alongside
   * it, which keeps the two costs in separate frames.
   */
  const scheduleBodies = useCallback(() => {
    if (bodyFrameRef.current !== null) return;
    const step = () => {
      bodyFrameRef.current = null;
      const container = scrollContainerRef.current;
      if (!container) return;
      const containerTop = container.getBoundingClientRect().top;
      const near = (element: HTMLElement) => {
        const top = element.getBoundingClientRect().top;
        return (
          top > containerTop - BODY_MARGIN_PX &&
          top < containerTop + container.clientHeight + BODY_MARGIN_PX
        );
      };

      for (const path of pendingBodiesRef.current) {
        pendingBodiesRef.current.delete(path);
        const element = sectionRefs.current.get(path);
        if (!element || !near(element)) continue;
        loadBodies([path]);
        pendingHighlightRef.current.add(path);
        scheduleHighlight();
        break;
      }
      if (pendingBodiesRef.current.size > 0) bodyFrameRef.current = requestAnimationFrame(step);
    };
    bodyFrameRef.current = requestAnimationFrame(step);
  }, [loadBodies, scheduleHighlight]);

  useEffect(
    () => () => {
      if (bodyFrameRef.current !== null) cancelAnimationFrame(bodyFrameRef.current);
      bodyFrameRef.current = null;
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
    programmaticScrollRef.current = true;

    let stableFrames = 0;
    let frames = 0;
    let expected = container.scrollTop;

    const finish = () => {
      settleFrameRef.current = null;
      programmaticScrollRef.current = false;
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
   * The body is forced rather than left to the observer. Comment navigation waits on a
   * MutationObserver for the comment's node and gives up after a couple of seconds, so a target
   * whose body has not been built has nothing for it to find; and the jump wants the file readable
   * on arrival, not a frame later.
   *
   * Building it moves nothing: a body grows below its own header, and the header is what the jump
   * scrolls to.
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
      loadBodies([path]);
      // Ahead of the queue: this is the file the user asked for, and it is one card's worth of
      // work. Whatever was waiting can wait a frame longer.
      pendingHighlightRef.current.delete(path);
      setHighlighted((prev) => (prev.has(path) ? prev : new Set([...prev, path])));
      scrollToTop(path);
    },
    [onBeforeReveal, scrollToTop, loadBodies],
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
   * built until it is actually looked at.
   *
   * It drives both tiers off one margin: a card that comes within `BODY_MARGIN_PX` gets its body
   * built, and joins the queue for colour. Two margins would only buy a window in which a card is
   * built but deliberately grey, and the queue already staggers the expensive half.
   *
   * Neither is taken back here. A file scrolled past keeps its body and its colour, so returning
   * to it costs nothing — bounding that is a separate concern, and one that has to hold on to the
   * height it is dropping.
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
          if (path === undefined || loadedBodiesRef.current.has(path)) continue;
          pendingBodiesRef.current.add(path);
          queued = true;
        }
        if (queued) scheduleBodies();
      },
      { root, rootMargin: `${BODY_MARGIN_PX}px 0px ${BODY_MARGIN_PX}px 0px` },
    );
    observerRef.current = observer;
    for (const element of sectionRefs.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [scheduleBodies]);

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

  const handleScroll = useCallback(() => {
    if (programmaticScrollRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    const cardTops = items.map((item) => {
      const element = sectionRefs.current.get(displayItemPath(item));
      return element ? element.getBoundingClientRect().top : null;
    });
    onSelectedIndexChange(activeIndexAt(cardTops, containerTop));
  }, [items, onSelectedIndexChange]);

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
      onScroll={handleScroll}
      // `overflow-anchor:none` because this stack corrects its own shifts. Chromium's scroll
      // anchoring would correct the same one, and the two adjustments would add up.
      className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 pb-3 flex flex-col [overflow-anchor:none]"
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
              {/* Nothing at all until the body is built — no reserved height, no placeholder. A
                  card the reader has not reached contributes only its header, and the document
                  grows in front of them as they go. */}
              {loadedBodies.has(key) &&
                (item.kind === "diff" ? (
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
                ))}
            </ReviewFileCard>
          );
        })}
    </div>
  );
}
