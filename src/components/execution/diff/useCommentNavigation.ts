import { useCallback, useEffect, useMemo, useRef } from "react";

/** Where a comment sits in the review, and how to step off it. */
export interface CommentNav {
  onPrev: () => void;
  onNext: () => void;
  /** `[index, total]`, 1-based. */
  position: [number, number];
}

/** The shape both stores' comments already have — `PendingComment` and `DiffAnnotation`. */
interface Anchored {
  id: string;
  filePath: string;
  lineNumber: number;
}

/** How long to keep waiting for a comment's node to mount before giving up. */
const REVEAL_TIMEOUT_MS = 2000;

interface UseCommentNavigationOptions<C extends Anchored> {
  /** Every pending comment in the review, in any order. */
  comments: C[];
  /** File paths in the order the host lists them. A path missing from this sorts last. */
  fileOrder: string[];
  /** Put `filePath` on screen. Fire-and-forget — the hook waits on the DOM, not on this. */
  revealFile: (filePath: string) => void;
  /** Where to look for `[data-comment-id]`. */
  container: React.RefObject<HTMLElement | null>;
}

/**
 * Walking the review's comments as one sequence, across files.
 *
 * The chevrons on a comment step through every comment in the review rather than the current
 * file's, so the position they show agrees with the count in the annotation bar. Ordering is the
 * order they are read on screen: by file as the host lists them, then by line.
 */
export function useCommentNavigation<C extends Anchored>({
  comments,
  fileOrder,
  revealFile,
  container,
}: UseCommentNavigationOptions<C>) {
  const orderedComments = useMemo(() => {
    const rank = new Map(fileOrder.map((path, i) => [path, i]));
    return [...comments].sort(
      (a, b) =>
        (rank.get(a.filePath) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.filePath) ?? Number.MAX_SAFE_INTEGER) || a.lineNumber - b.lineNumber,
    );
  }, [comments, fileOrder]);

  /** Tears down the previous jump's watcher, so a second jump supersedes rather than races it. */
  const cancelPendingReveal = useRef<(() => void) | null>(null);

  /**
   * Reveal a comment, opening its file first when it lives in another one.
   *
   * The comment is inside a diff this hook's host does not render itself, so it is found by the
   * `data-comment-id` the viewer tags it with rather than through a ref. That node does not exist
   * until the file is on screen and its diff has mounted — a re-render plus a syntax highlight —
   * so wait for the DOM to produce it rather than guessing at a delay. A fixed timeout was either
   * too short for a large file or a visible pause for a small one.
   */
  const goToComment = useCallback(
    (id: string) => {
      const target = orderedComments.find((c) => c.id === id);
      if (!target) return;

      cancelPendingReveal.current?.();
      revealFile(target.filePath);

      const find = () =>
        container.current?.querySelector(`[data-comment-id="${CSS.escape(id)}"]`) ?? null;

      const scrollTo = (node: Element) =>
        node.scrollIntoView({ block: "center", behavior: "smooth" });

      // Already on screen — the common case, stepping between comments in one file.
      const present = find();
      if (present) {
        scrollTo(present);
        return;
      }

      const root = container.current;
      if (!root) return;

      const observer = new MutationObserver(() => {
        const node = find();
        if (!node) return;
        cancelPendingReveal.current?.();
        scrollTo(node);
      });
      observer.observe(root, { childList: true, subtree: true });

      const timer = setTimeout(() => cancelPendingReveal.current?.(), REVEAL_TIMEOUT_MS);
      cancelPendingReveal.current = () => {
        observer.disconnect();
        clearTimeout(timer);
        cancelPendingReveal.current = null;
      };
    },
    [orderedComments, revealFile, container],
  );

  // A jump can outlive the panel that started it — the observer and its timer are ours to drop.
  useEffect(() => () => cancelPendingReveal.current?.(), []);

  /**
   * Memoized on the ordering rather than rebuilt per comment: its identity reaches
   * `DiffViewer`'s `renderExtendLine`, and churning it re-renders every comment in the diff.
   */
  const commentNav = useCallback(
    (id: string): CommentNav | null => {
      // One comment has nowhere to step to, and chevrons that only lead back to themselves read
      // as broken.
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
        position: [at + 1, orderedComments.length],
      };
    },
    [orderedComments, goToComment],
  );

  return { orderedComments, goToComment, commentNav };
}
