import { useCallback, useEffect, useId, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { PendingCommentBlock } from "@/components/execution/diff/PendingCommentBlock";
import { useAnnotationStore, useSessionAnnotations } from "@/store/annotationStore";
import type { Annotation } from "@/store/annotationStore";
import { AnnotationBar } from "./AnnotationBar";
import { AnnotationComposer } from "./AnnotationComposer";
import { quoteFromSelection, rangeForQuote, rangeContainsPoint } from "./plan-anchor";
import { setHighlightRanges, clearHighlightRanges } from "./plan-highlight";

const SHELL_WIDTH = 400;
/** Leave the focused annotation this far below the bar when navigating to it. */
const SCROLL_MARGIN = 80;
// Placement needs a height before the shell exists, so each one is approximated. Over-estimating
// only flips a shell above its anchor slightly early; under-estimating puts its footer — and the
// buttons on it — off the bottom of the pane, where they cannot be clicked.
const HINT_HEIGHT = 36;
const COMPOSER_HEIGHT = 172;
const COMMENT_HEIGHT = 116;

interface PlanAnnotationLayerProps {
  sessionKey: number;
  onSend: (annotations: Annotation[]) => void;
  sendDisabled?: boolean;
  /** Classes for the scrolling content area — padding and type styles of the host pane. */
  scrollClassName?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * Wraps rendered plan markdown so a text selection can be annotated. Annotated text stays
 * highlighted and clicking it reopens the same floating bubble it was created in.
 *
 * Owns the pane's top bar and scroll area, because navigating between annotations needs both the
 * live ranges and the scroller, and the bar is where the send button and that navigation live.
 */
export function PlanAnnotationLayer({
  sessionKey,
  onSend,
  sendDisabled,
  scrollClassName = "px-4 py-4 text-sm",
  className,
  children,
}: PlanAnnotationLayerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const annotations = useSessionAnnotations(sessionKey, "plan");
  const { addAnnotation, updateAnnotation, removeAnnotations } = useAnnotationStore();
  const instanceId = useId();

  // `x`/`y` are the viewport point the shell was anchored to, kept so the composer can be
  // re-placed when it opens: it is far taller than the hint it replaces, and a position that
  // suited the hint can leave the composer's footer off-screen.
  const [pending, setPending] = useState<{
    quote: string;
    occurrence: number;
    x: number;
    y: number;
    top: number;
    left: number;
    composing: boolean;
  } | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [viewPos, setViewPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const navIndexRef = useRef(-1);

  // Repaint highlights whenever the notes or the plan text change. Ranges are rebuilt from the
  // quote rather than stored, so a mid-stream re-render of the plan does not lose them.
  //
  // The annotation being written is painted too: focusing the composer drops the native selection
  // (a document has only one), so without this the text you are commenting on stops looking picked.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ranges: Range[] = [];
    for (const a of annotations) {
      if (a.kind !== "plan") continue;
      const range = rangeForQuote(container, a.quote, a.occurrence);
      if (range) ranges.push(range);
    }
    if (pending) {
      const range = rangeForQuote(container, pending.quote, pending.occurrence);
      if (range) ranges.push(range);
    }
    setHighlightRanges(instanceId, ranges);
  }, [annotations, instanceId, children, pending]);

  useEffect(() => () => clearHighlightRanges(instanceId), [instanceId]);

  /**
   * Place a shell of `height` at a viewport point, kept inside the visible pane.
   *
   * Vertical placement is measured against the scroller's box, not the container's: the container
   * is the whole plan and is taller than the window, so clamping to it would still let a shell
   * anchored near the bottom render past the edge with its actions out of reach.
   */
  const place = useCallback((x: number, y: number, height: number) => {
    const container = containerRef.current;
    const scroller = scrollRef.current;
    if (!container || !scroller) return { top: 0, left: 0 };
    const box = container.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const anchor = y - box.top;
    const visTop = view.top - box.top;
    const visBottom = view.bottom - box.top;

    let top = anchor + 8;
    if (top + height > visBottom) {
      top = anchor - 8 - height; // flip above the anchor
      if (top < visTop) top = Math.max(visTop, visBottom - height); // too tall either way — pin
    }

    const maxLeft = Math.max(0, container.clientWidth - SHELL_WIDTH);
    return {
      top,
      left: Math.min(Math.max(0, x - box.left), maxLeft),
    };
  }, []);

  /** Swap the hint for the composer, re-placing it for its greater height. */
  const openComposer = useCallback(() => {
    setPending((prev) =>
      prev ? { ...prev, composing: true, ...place(prev.x, prev.y, COMPOSER_HEIGHT) } : prev,
    );
  }, [place]);

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (pending?.composing) return;
      const container = containerRef.current;
      if (!container) return;
      const anchor = quoteFromSelection(container, window.getSelection());
      if (!anchor) {
        setPending(null);
        return;
      }
      // Anchored to the pointer, not to the selection's bounding box: a selection spanning several
      // lines has a box starting at the paragraph's left edge, which puts the bubble nowhere near
      // where the user let go.
      setPending({
        ...anchor,
        x: e.clientX,
        y: e.clientY,
        ...place(e.clientX, e.clientY, HINT_HEIGHT),
        composing: false,
      });
      setViewingId(null);
    },
    [pending?.composing, place],
  );

  const openAnnotation = useCallback(
    (annotation: Annotation, range: Range) => {
      const rect = range.getBoundingClientRect();
      setViewPos(place(rect.left, rect.bottom, COMMENT_HEIGHT));
      setViewingId(annotation.id);
      setPending(null);
    },
    [place],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // A drag that produced a selection is a create gesture, not a click on a highlight.
      if (window.getSelection()?.isCollapsed === false) return;
      const container = containerRef.current;
      if (!container) return;
      for (const a of annotations) {
        if (a.kind !== "plan") continue;
        const range = rangeForQuote(container, a.quote, a.occurrence);
        if (range && rangeContainsPoint(range, e.clientX, e.clientY)) {
          openAnnotation(a, range);
          return;
        }
      }
      setViewingId(null);
    },
    [annotations, openAnnotation],
  );

  /** Reveal one annotation: scroll its quote into view and open its bubble on it. */
  const goTo = useCallback(
    (id: string) => {
      const container = containerRef.current;
      const scroller = scrollRef.current;
      if (!container || !scroller) return;

      const index = annotations.findIndex((a) => a.id === id);
      const a = annotations[index];
      if (!a || a.kind !== "plan") return;
      navIndexRef.current = index;

      const range = rangeForQuote(container, a.quote, a.occurrence);
      if (!range) return;

      const top = range.getBoundingClientRect().top - container.getBoundingClientRect().top;
      scroller.scrollTo({
        top: Math.max(0, container.offsetTop + top - SCROLL_MARGIN),
        behavior: "smooth",
      });
      // Re-measure after the scroll so the bubble lands on the text, not where it used to be.
      requestAnimationFrame(() => {
        const settled = rangeForQuote(container, a.quote, a.occurrence);
        if (settled) openAnnotation(a, settled);
      });
    },
    [annotations, openAnnotation],
  );

  /** Step to the next/previous annotation. Wraps at both ends. */
  const navigate = useCallback(
    (delta: 1 | -1) => {
      if (annotations.length === 0) return;
      const current = annotations.findIndex((a) => a.id === viewingId);
      const from = current >= 0 ? current : navIndexRef.current;
      goTo(annotations[(from + delta + annotations.length * 2) % annotations.length].id);
    },
    [annotations, viewingId, goTo],
  );

  // Enter opens the composer on a fresh selection, matching the bubble's hint; Escape dismisses
  // whichever bubble is open. Capture phase with stopImmediatePropagation, because
  // PlanPermissionOverlay also listens on window for Escape and dismissing a bubble must not
  // answer the plan.
  //
  // This has to arm for `viewing` too, not just `pending`: that overlay's own guard spares only
  // inputs and textareas, and a reopened bubble renders its comment as a div, so Escape there
  // used to fall through and reject the plan.
  //
  // Keystrokes aimed at a field are left alone, for the mirror-image reason — the composer and
  // PendingCommentBlock's edit mode each cancel on their own Escape, and swallowing it here
  // would close the whole bubble instead of just the edit.
  useEffect(() => {
    const selecting = pending !== null && !pending.composing;
    if (!selecting && viewingId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      if (e.key === "Enter" && selecting) {
        e.preventDefault();
        e.stopImmediatePropagation();
        openComposer();
      } else if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setPending(null);
        setViewingId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [pending, viewingId, openComposer]);

  const viewing = annotations.find((a) => a.id === viewingId) ?? null;
  const shellStops = {
    onMouseUp: (e: React.MouseEvent) => e.stopPropagation(),
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  };

  return (
    <div className={cn("flex flex-col min-h-0", className)}>
      {/* One right-hand slot. The hint is an affordance rather than a status, so it sits where
          the control that supersedes it will appear instead of being stranded opposite it. */}
      <div className="flex items-center justify-end h-10 px-2 border-b border-border bg-card/50 shrink-0">
        {annotations.length === 0 ? (
          <span className="text-[11px] text-muted-foreground truncate">
            Select any text to annotate the plan
          </span>
        ) : (
          <AnnotationBar
            sessionKey={sessionKey}
            kind="plan"
            onSend={onSend}
            sendDisabled={sendDisabled}
            onGoTo={goTo}
            activeId={viewingId}
          />
        )}
      </div>

      <div
        ref={scrollRef}
        className={cn("flex-1 overflow-y-auto custom-scrollbar", scrollClassName)}
      >
        <div
          ref={containerRef}
          className="relative"
          onMouseUp={handleMouseUp}
          onClick={handleClick}
        >
          {children}

          {pending && (
            // Clicks must not reach the container: its handler treats a click off a highlight as
            // "dismiss", which would unmount the bubble before its own buttons could act.
            <div
              className="absolute z-20"
              style={{ top: pending.top, left: pending.left, width: SHELL_WIDTH }}
              {...shellStops}
            >
              {pending.composing ? (
                <AnnotationComposer
                  onSubmit={(text) => {
                    addAnnotation(sessionKey, {
                      id: crypto.randomUUID(),
                      kind: "plan",
                      quote: pending.quote,
                      occurrence: pending.occurrence,
                      text,
                    });
                    setPending(null);
                    window.getSelection()?.removeAllRanges();
                  }}
                  onCancel={() => setPending(null)}
                />
              ) : (
                <button
                  type="button"
                  onClick={openComposer}
                  // Opaque in both states — a translucent hover shows the plan text through it.
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-accent bg-popover shadow-lg text-xs text-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                >
                  <MessageSquarePlus className="w-3.5 h-3.5" />
                  Comment
                  <span className="ml-1 px-1 py-px rounded-[3px] text-[10px] font-mono bg-muted text-muted-foreground">
                    Enter
                  </span>
                </button>
              )}
            </div>
          )}

          {viewing && viewing.kind === "plan" && (
            <div
              className="absolute z-20"
              style={{ top: viewPos.top, left: viewPos.left, width: SHELL_WIDTH }}
              {...shellStops}
            >
              <div className="rounded-lg border border-accent/50 bg-popover shadow-xl overflow-hidden">
                <PendingCommentBlock
                  bare
                  text={viewing.text}
                  onEdit={(text) => updateAnnotation(sessionKey, viewing.id, text)}
                  onRemove={() => {
                    removeAnnotations(sessionKey, [viewing.id]);
                    setViewingId(null);
                  }}
                  onSend={() => {
                    onSend([viewing]);
                    setViewingId(null);
                  }}
                  sendDisabled={sendDisabled}
                  {...(annotations.length > 1 && {
                    onPrev: () => navigate(-1),
                    onNext: () => navigate(1),
                    position: [annotations.indexOf(viewing) + 1, annotations.length] as [
                      number,
                      number,
                    ],
                  })}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
