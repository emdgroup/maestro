import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { DiffModeEnum } from "@git-diff-view/react";
import { type PendingComment } from "./DiffViewer";
import { ExpandableDiffViewer } from "./ExpandableDiffViewer";
import { UntrackedFileDiffViewer } from "./UntrackedFileDiffViewer";
import { ReviewFileCard, fileNote } from "./ReviewFileCard";
import { estimateDiffHeight } from "./estimate-diff-height";
import { useCommentNavigation } from "./useCommentNavigation";
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

  // Which files' diffs have actually been built. Every card is expanded, but a diff is a Shiki
  // highlight per line, and mounting hundreds at once exhausts WebView2 memory — so a body waits
  // until its card comes near the viewport. See `nearby` below.
  const [mounted, setMounted] = useState<Set<string>>(new Set());
  const [forcedMounts, setForcedMounts] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback((key: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * Put a file on screen, by path rather than by index: the host may be about to add it back to
   * a filtered list, in which case it has no index yet but its collapsed state and its section can
   * both be addressed by path already.
   *
   * The forced mount is what makes comment navigation work. `goToComment` waits on a
   * MutationObserver for the comment's node and gives up after a couple of seconds; if the target
   * file is far off screen its body would never mount, no node would appear, and the chevron would
   * silently do nothing.
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
      setForcedMounts((prev) => (prev.has(path) ? prev : new Set([...prev, path])));
      programmaticScrollRef.current = true;
      setTimeout(() => {
        sectionRefs.current.get(path)?.scrollIntoView({ block: "start", behavior: "smooth" });
        setTimeout(() => {
          programmaticScrollRef.current = false;
        }, 700);
      }, 0);
    },
    [onBeforeReveal],
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
   * Rooted at the scroller rather than the viewport, which also means a hidden session — the
   * agent monitor keeps them all mounted — has a zero-size root, so nothing intersects and nothing
   * mounts until it is actually looked at.
   *
   * A mounted body is never unmounted. Partly so an open comment draft survives scrolling away,
   * but mainly for the scroll spy: mounting swaps an estimated height for the real one, and if
   * everything above the scroll position is already mounted then that only ever happens *below*
   * the viewport, where it shifts nothing the user can see and leaves `offsetTop` for the cards
   * they have passed untouched. The margin is asymmetric for the same reason — generous below,
   * where growth is free, and small above, where it is not.
   */
  const observerRef = useRef<IntersectionObserver | null>(null);
  const pathByElement = useRef(new WeakMap<Element, string>());
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const arrived = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => pathByElement.current.get(entry.target))
          .filter((path): path is string => path !== undefined);
        if (arrived.length === 0) return;
        setMounted((prev) => {
          if (arrived.every((path) => prev.has(path))) return prev;
          return new Set([...prev, ...arrived]);
        });
      },
      { root, rootMargin: "200px 0px 800px 0px" },
    );
    observerRef.current = observer;
    for (const element of sectionRefs.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, []);

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
    const scrollTop = container.scrollTop;
    let activeIndex = 0;
    items.forEach((item, idx) => {
      const el = sectionRefs.current.get(displayItemPath(item));
      if (el && el.offsetTop <= scrollTop + 1) activeIndex = idx;
    });
    onSelectedIndexChange(activeIndex);
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
          const isMounted = mounted.has(key) || forcedMounts.has(key);
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
              {isMounted ? (
                item.kind === "diff" ? (
                  <ExpandableDiffViewer
                    file={item.file}
                    projectId={projectId}
                    cwd={cwd}
                    diffTarget={diffTarget}
                    diffViewMode={diffViewMode}
                    {...reviewProps(key)}
                  />
                ) : (
                  <UntrackedFileDiffViewer
                    projectId={projectId}
                    worktreePath={cwd}
                    filePath={item.path}
                    showHeader={false}
                    {...reviewProps(key)}
                  />
                )
              ) : (
                // Reserves roughly the diff's height so the stack scrolls at its true length.
                // Without it every card would sit inside the observer's margin at once and the
                // whole point of waiting would be lost.
                <div style={{ height: estimateDiffHeight(hunks) }} aria-hidden />
              )}
            </ReviewFileCard>
          );
        })}
    </div>
  );
}
