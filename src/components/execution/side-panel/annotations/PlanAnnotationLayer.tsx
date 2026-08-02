import { useCallback, useEffect, useId, useRef, useState } from "react";
import { MessageSquarePlus, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
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

  const [pending, setPending] = useState<{
    quote: string;
    occurrence: number;
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

  /** Place a shell at a viewport point, clamped inside the content column. */
  const place = useCallback((x: number, y: number) => {
    const container = containerRef.current;
    if (!container) return { top: 0, left: 0 };
    const box = container.getBoundingClientRect();
    const maxLeft = Math.max(0, container.clientWidth - SHELL_WIDTH);
    return {
      top: y - box.top + 8,
      left: Math.min(Math.max(0, x - box.left), maxLeft),
    };
  }, []);

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
      setPending({ ...anchor, ...place(e.clientX, e.clientY), composing: false });
      setViewingId(null);
    },
    [pending?.composing, place],
  );

  const openAnnotation = useCallback(
    (annotation: Annotation, range: Range) => {
      const rect = range.getBoundingClientRect();
      setViewPos(place(rect.left, rect.bottom));
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

  /** Step to the next/previous annotation: scroll it into view and open its bubble. */
  const navigate = useCallback(
    (delta: 1 | -1) => {
      const container = containerRef.current;
      const scroller = scrollRef.current;
      if (!container || !scroller || annotations.length === 0) return;

      const current = annotations.findIndex((a) => a.id === viewingId);
      const from = current >= 0 ? current : navIndexRef.current;
      const next = (from + delta + annotations.length * 2) % annotations.length;
      navIndexRef.current = next;

      const a = annotations[next];
      if (a.kind !== "plan") return;
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
    [annotations, viewingId, openAnnotation],
  );

  // Enter opens the composer on a fresh selection, matching the bubble's hint. Capture phase with
  // stopImmediatePropagation, because PlanPermissionOverlay also listens on window for Escape and
  // dismissing the bubble must not answer the plan.
  useEffect(() => {
    if (!pending || pending.composing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setPending((prev) => (prev ? { ...prev, composing: true } : prev));
      } else if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setPending(null);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [pending]);

  const viewing = annotations.find((a) => a.id === viewingId) ?? null;
  const shellStops = {
    onMouseUp: (e: React.MouseEvent) => e.stopPropagation(),
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  };

  return (
    <div className={cn("flex flex-col min-h-0", className)}>
      <div className="flex items-center h-10 px-2 gap-2 border-b border-border bg-card/50 shrink-0">
        <span className="text-[11px] text-muted-foreground truncate">
          Select any text to annotate the plan
        </span>
        <div className="flex items-center gap-1 ml-auto shrink-0">
          {annotations.length > 1 && (
            <>
              <Tooltip>
                <TooltipTrigger
                  type="button"
                  onClick={() => navigate(-1)}
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </TooltipTrigger>
                <TooltipContent>Previous annotation</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  type="button"
                  onClick={() => navigate(1)}
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </TooltipTrigger>
                <TooltipContent>Next annotation</TooltipContent>
              </Tooltip>
            </>
          )}
          <AnnotationBar
            sessionKey={sessionKey}
            kind="plan"
            onSend={onSend}
            sendDisabled={sendDisabled}
          />
        </div>
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
                  quote={pending.quote}
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
                  onClick={() => setPending({ ...pending, composing: true })}
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
              <div className="rounded-lg border border-accent/50 bg-popover shadow-xl">
                <PendingCommentBlock
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
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
