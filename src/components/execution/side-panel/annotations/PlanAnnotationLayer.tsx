import { useCallback, useEffect, useId, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { InlineCommentInput } from "@/components/execution/diff/InlineCommentInput";
import { PendingCommentBlock } from "@/components/execution/diff/PendingCommentBlock";
import { useAnnotationStore, useSessionAnnotations } from "@/store/annotationStore";
import type { Annotation } from "@/store/annotationStore";
import { quoteFromSelection, rangeForQuote, rangeContainsPoint } from "./plan-anchor";
import { setHighlightRanges, clearHighlightRanges } from "./plan-highlight";

const SHELL_WIDTH = 320;

interface PlanAnnotationLayerProps {
  sessionKey: number;
  onSend: (annotations: Annotation[]) => void;
  sendDisabled?: boolean;
  children: React.ReactNode;
}

/**
 * Wraps rendered plan markdown so a text selection can be annotated. Annotated text stays
 * highlighted and clicking it reopens the same floating bubble it was created in.
 */
export function PlanAnnotationLayer({
  sessionKey,
  onSend,
  sendDisabled,
  children,
}: PlanAnnotationLayerProps) {
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

  const place = useCallback((rect: DOMRect) => {
    const container = containerRef.current;
    if (!container) return { top: 0, left: 0 };
    const box = container.getBoundingClientRect();
    const maxLeft = Math.max(0, container.clientWidth - SHELL_WIDTH - 8);
    return {
      top: rect.bottom - box.top + 6,
      left: Math.min(Math.max(0, rect.left - box.left), maxLeft),
    };
  }, []);

  const handleMouseUp = useCallback(() => {
    if (pending?.composing) return;
    const container = containerRef.current;
    if (!container) return;
    const selection = window.getSelection();
    const anchor = quoteFromSelection(container, selection);
    if (!anchor || !selection) {
      setPending(null);
      return;
    }
    setPending({
      ...anchor,
      ...place(selection.getRangeAt(0).getBoundingClientRect()),
      composing: false,
    });
    setViewingId(null);
  }, [pending?.composing, place]);

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
          setViewPos(place(range.getBoundingClientRect()));
          setViewingId(a.id);
          setPending(null);
          return;
        }
      }
      setViewingId(null);
    },
    [annotations, place],
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

  return (
    <div ref={containerRef} className="relative" onMouseUp={handleMouseUp} onClick={handleClick}>
      {children}

      {pending && (
        // Clicks must not reach the container: its handler treats a click off a highlight as
        // "dismiss", which would unmount the bubble before its own buttons could act.
        <div
          className="absolute z-20"
          style={{ top: pending.top, left: pending.left, width: SHELL_WIDTH }}
          onMouseUp={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Solid backdrop: the reused blocks are translucent, which is illegible over plan
              text. Their own margins act as this bubble's padding. */}
          {pending.composing ? (
            <div className="rounded-md border border-border bg-popover shadow-lg">
              <InlineCommentInput
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
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPending({ ...pending, composing: true })}
              // Opaque in both states — a translucent hover shows the plan text through the
              // bubble.
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
          onMouseUp={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="rounded-md border border-border bg-popover shadow-lg">
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
  );
}
