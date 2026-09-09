import { useCallback, useLayoutEffect, useRef, useState } from "react";

export const SIDEBAR_MIN_WIDTH = 256;
export const SIDEBAR_MAX_WIDTH = 700;

/** Below this the file panel and a readable diff cannot share a row, so the panel floats instead. */
const FIXED_LAYOUT_MIN_WIDTH = 1300;

export type ReviewPanelLayout = "fixed" | "overlay";

/**
 * What a measured container width allows.
 *
 * `null` means "no opinion": a container that measures 0 is hidden, not narrow. AgentMonitor keeps
 * every session mounted and hides the unselected ones, so without this a background Changes tab
 * would flip to overlay and back every time the user switches session.
 */
export function reviewPanelLayout(width: number): ReviewPanelLayout | null {
  if (width <= 0) return null;
  return width >= FIXED_LAYOUT_MIN_WIDTH ? "fixed" : "overlay";
}

/**
 * Keep a stored width inside the range the panel enforces live. The drag cannot leave it out of
 * range, but a corrupt or hand-edited storage value must not reach the panel's initial size.
 */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_MIN_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

/**
 * Storage keys are namespaced so a host that is not the review can keep its own answer. The Files
 * tab sits in the same side panel as the Changes tab and uses the same layout, but they are two
 * different lists — toggling one must not toggle the other.
 */
const widthKey = (prefix: string) => `${prefix}:sidebarWidth`;
const openKey = (prefix: string) => `${prefix}:panelOpen`;

// Storage can throw (private mode, disabled cookies). A remembered pane width is never worth
// taking the review down for.
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preference is best-effort */
  }
}

export function readSidebarWidth(keyPrefix = "review"): number {
  const stored = read(widthKey(keyPrefix));
  return clampSidebarWidth(stored === null ? SIDEBAR_MIN_WIDTH : Number(stored));
}

export function readPanelOpen(keyPrefix = "review"): boolean {
  return read(openKey(keyPrefix)) !== "false";
}

/**
 * The review's file-panel layout: whether it sits inline or floats, how wide it is, and whether
 * it is open. Width and open state are shared by both review surfaces and survive a restart.
 *
 * The container ref is returned rather than taken, because the host owns the element whose width
 * decides the layout — and the host needs the verdict itself to render the right chrome. Passing
 * the measurement back up from a child would loop: measure → setState → re-render → measure.
 *
 * `keyPrefix` namespaces the stored width and open state. Hosts showing the same list share the
 * default; a host showing a different list passes its own.
 */
export function useReviewPanelLayout(keyPrefix = "review") {
  const containerRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<ReviewPanelLayout>("fixed");
  const [sidebarWidth, setWidth] = useState(() => readSidebarWidth(keyPrefix));
  const [panelOpen, setOpen] = useState(() => readPanelOpen(keyPrefix));
  // Mirrors `layout` for the callbacks below, which must not re-create on every flip.
  const layoutRef = useRef<ReviewPanelLayout>("fixed");
  const draggedWidth = useRef(sidebarWidth);
  // Captured once, for the same reason: a host's prefix is fixed for the life of the hook, and
  // holding it here keeps the measurement effect and the drag callbacks free of it as a dependency.
  const prefixRef = useRef(keyPrefix);

  // Measured before paint, so the first frame is already the right layout rather than a flash of
  // the wrong one.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const apply = (width: number) => {
      const next = reviewPanelLayout(width);
      if (!next || next === layoutRef.current) return;
      layoutRef.current = next;
      setLayout(next);
      // The floating panel covers the diff it is meant to navigate, so it opens on demand and
      // starts closed. The inline one is a column the user chose to keep, so it comes back the
      // way they left it.
      setOpen(next === "overlay" ? false : readPanelOpen(prefixRef.current));
    };

    apply(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => apply(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /**
   * Per drag frame. Deliberately does not set state.
   *
   * react-resizable-panels re-registers a panel whenever `defaultSize` changes, and re-registering
   * re-applies the layout. Feeding a dragged width straight back into `defaultSize` therefore
   * resets the drag on every frame, and the handle moves a pixel or two and stops.
   */
  const trackSidebarWidth = useCallback((width: number) => {
    draggedWidth.current = clampSidebarWidth(width);
    write(widthKey(prefixRef.current), String(draggedWidth.current));
  }, []);

  /**
   * Once the pointer is released. Adopting the width here re-registers the panel exactly once, at
   * the size it already has — so nothing moves, and reopening the panel starts where the drag
   * ended rather than where the review opened.
   */
  const commitSidebarWidth = useCallback(() => setWidth(draggedWidth.current), []);

  const setPanelOpen = useCallback((open: boolean) => {
    setOpen(open);
    // Only the inline layout's state is a preference. The overlay always starts closed, so
    // recording a dismissal there would collapse the inline panel on the next wide review.
    if (layoutRef.current === "fixed") write(openKey(prefixRef.current), String(open));
  }, []);

  return {
    containerRef,
    layout,
    // "The panel is a column beside the diff", which is the one thing three separate pieces of
    // chrome need to agree on: the diff's rounded corner, its left border, and the gap the action
    // bar takes above itself to stay centred against that corner.
    inset: layout === "fixed" && panelOpen,
    sidebarWidth,
    trackSidebarWidth,
    commitSidebarWidth,
    panelOpen,
    setPanelOpen,
  };
}

export type ReviewPanelState = ReturnType<typeof useReviewPanelLayout>;
