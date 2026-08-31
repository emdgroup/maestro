import { useCallback, useEffect, useRef, useState } from "react";
import { SquareDashedMousePointer } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { PendingCommentBlock } from "@/components/execution/diff/PendingCommentBlock";
import { useAnnotationStore, useSessionAnnotations } from "@/store/annotationStore";
import type { Annotation, CanvasAnnotation } from "@/store/annotationStore";
import type { CanvasSurface } from "@/components/execution/activity/types";
import { AnnotationBar } from "./AnnotationBar";
import { AnnotationComposer } from "./AnnotationComposer";
import { CaptureChip } from "./CaptureChip";
import { describeCanvasSubtree } from "./build-annotation-prompt";
import { captureRegion, type CanvasCapture } from "./canvas-capture";
import {
  boundingRect,
  isStale,
  pickAt,
  pickInRect,
  readNodes,
  resolveRects,
  uncapturableKinds,
  type CanvasNode,
} from "./canvas-anchor";

const SHELL_WIDTH = 340;
const SCROLL_MARGIN = 60;
/** Below this a press is a click on one component; above it, a marquee over a region. */
const DRAG_THRESHOLD = 4;
// Placement needs a height before the shell exists, so each is approximated. Over-estimating only
// flips a shell above its anchor early; under-estimating puts its buttons off the bottom.
const COMPOSER_HEIGHT = 210;
const COMMENT_HEIGHT = 120;

interface CanvasAnnotationLayerProps {
  sessionKey: number;
  /** The surface on screen. Notes are keyed to it, and the bar can span several. */
  surface: CanvasSurface;
  onSend: (annotations: Annotation[]) => void;
  sendDisabled?: boolean;
  /** The agent takes image blocks. Without it a drag still selects, it just does not capture. */
  canCapture?: boolean;
  /** Page the carousel, so a note on another surface can be revealed from the bar. */
  onRequestSurface: (surfaceId: string) => void;
  /** The tab's own chrome: `title` yields to the annotation bar, `actions` never does. */
  header: { title: React.ReactNode; actions: React.ReactNode };
  children: React.ReactNode;
}

type Pending = {
  ids: string[];
  /** Viewport rect the note was taken over, for placing the composer and framing the highlight. */
  rect: { left: number; top: number; width: number; height: number };
  shot: CanvasCapture | null;
  /** `off` for a click, which never captures; the rest track the drag's capture. */
  capture: "off" | "pending" | "done" | "failed";
  top: number;
  left: number;
};

/**
 * Wraps a rendered canvas so a component or a region can be annotated.
 *
 * A canvas is live and its controls are real, so annotating is behind an explicit mode rather than
 * on the default click. In that mode the gesture splits: a click anchors to the component under the
 * pointer, a drag marquees a region and captures it. See `canvas-anchor.ts` for what each selects.
 *
 * Owns the tab's header row, because the annotation bar and the mode toggle belong beside the
 * surface chrome, and navigating between notes needs the scroller this component already holds.
 */
export function CanvasAnnotationLayer({
  sessionKey,
  surface,
  onSend,
  sendDisabled,
  canCapture,
  onRequestSurface,
  header,
  children,
}: CanvasAnnotationLayerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const all = useSessionAnnotations(sessionKey, "canvas") as CanvasAnnotation[];
  const { addAnnotation, updateAnnotation, removeAnnotations, clearAnnotationCapture } =
    useAnnotationStore();

  const [active, setActive] = useState(false);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  // Origin of the overlay frame in viewport coordinates. Captured in the same pass as
  // `nodes` — both are viewport measurements and must come from one layout read, or a
  // frame mid-scroll would offset fresh rects against a stale origin.
  const [frameOrigin, setFrameOrigin] = useState({ left: 0, top: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<DOMRect | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [viewPos, setViewPos] = useState({ top: 0, left: 0 });
  const pressRef = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  // Mirrors `marquee` for the window listeners, which would otherwise close over a stale value.
  const marqueeRef = useRef<DOMRect | null>(null);
  const [pressing, setPressing] = useState(false);
  const deferredGoToRef = useRef<string | null>(null);

  const mine = all.filter((a) => a.surfaceId === surface.surfaceId);

  // Geometry is re-read rather than stored, for the reason `plan-anchor` rebuilds its Ranges: the
  // agent rewrites the surface mid-session and anything measured before that is a lie.
  const refresh = useCallback(() => {
    if (contentRef.current) {
      const measured = readNodes(contentRef.current);
      // Only adopt a measurement that found something. A collapsed side panel lays its
      // contents out at zero size, which `readNodes` skips entirely — adopting that empty
      // result discarded the geometry every saved note is resolved against, so re-opening
      // the panel left them all reading as stale.
      if (measured.length > 0) setNodes(measured);
    }
    const box = frameRef.current?.getBoundingClientRect();
    if (box) {
      setFrameOrigin((prev) =>
        prev.left === box.left && prev.top === box.top ? prev : { left: box.left, top: box.top },
      );
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
    const scroller = scrollRef.current;
    const observer = new ResizeObserver(refresh);
    if (contentRef.current) observer.observe(contentRef.current);
    scroller?.addEventListener("scroll", refresh);
    return () => {
      observer.disconnect();
      scroller?.removeEventListener("scroll", refresh);
    };
  }, [active, refresh, children, surface]);

  // Leaving the mode drops everything transient with it — a highlight with no way to act on it is
  // just a decoration the user cannot dismiss. Adjusted during render rather than from an effect,
  // so the overlay never paints a frame of stale highlights after the mode is switched off.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) {
      setHoverId(null);
      setMarquee(null);
      setPending(null);
      setViewingId(null);
    }
  }

  useEffect(() => {
    if (active) return;
    pressRef.current = null;
  }, [active]);

  /** Viewport point to a position inside the scrolling frame, kept within the visible pane. */
  const place = useCallback((x: number, y: number, height: number) => {
    const frame = frameRef.current;
    const scroller = scrollRef.current;
    if (!frame || !scroller) return { top: 0, left: 0 };
    const box = frame.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const anchor = y - box.top;
    const visTop = view.top - box.top;
    const visBottom = view.bottom - box.top;

    let top = anchor + 8;
    if (top + height > visBottom) {
      top = anchor - 8 - height;
      if (top < visTop) top = Math.max(visTop, visBottom - height);
    }
    const maxLeft = Math.max(0, frame.clientWidth - SHELL_WIDTH);
    return { top, left: Math.min(Math.max(0, x - box.left), maxLeft) };
  }, []);

  /**
   * Viewport rect to one positioned inside the frame, which is what the overlay is sized to.
   *
   * Subtracts the stored origin rather than measuring: this runs during render to build
   * inline styles, and a `getBoundingClientRect()` there is both impure and a forced
   * layout on every render of the overlay.
   */
  const toFrame = useCallback(
    (rect: { left: number; top: number; width: number; height: number }) => ({
      left: rect.left - frameOrigin.left,
      top: rect.top - frameOrigin.top,
      width: rect.width,
      height: rect.height,
    }),
    [frameOrigin],
  );

  const openComposer = useCallback(
    (
      ids: string[],
      rect: { left: number; top: number; width: number; height: number },
      at: { x: number; y: number },
      capture: boolean,
    ) => {
      setHoverId(null);
      setViewingId(null);
      setPending({
        ids,
        rect,
        shot: null,
        capture: capture ? "pending" : "off",
        ...place(at.x, at.y, COMPOSER_HEIGHT),
      });
      if (!capture) return;
      // Taken now rather than at send: by then the agent may have redrawn the surface, and a
      // screenshot of something the user never saw is worse than none.
      const content = contentRef.current;
      if (!content) return;
      void captureRegion(content, rect).then((shot) =>
        setPending((prev) => (prev ? { ...prev, shot, capture: shot ? "done" : "failed" } : prev)),
      );
    },
    [place],
  );

  const openAnnotation = useCallback(
    (annotation: CanvasAnnotation, rects: DOMRect[]) => {
      const bounds = boundingRect(rects);
      const x = bounds?.left ?? 0;
      const y = bounds?.bottom ?? 0;
      setViewPos(place(x, y, COMMENT_HEIGHT));
      setViewingId(annotation.id);
      setPending(null);
      setHoverId(null);
    },
    [place],
  );

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Stops the browser starting a text selection or an image drag under the pointer. Without it,
    // a drag that reaches the pane's edge turns into a selection of whatever is behind the canvas.
    e.preventDefault();
    pressRef.current = { x: e.clientX, y: e.clientY, dragging: false };
    setPressing(true);
  }, []);

  /** Hover only. Once a press is down the gesture is tracked on the window instead — see below. */
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (pressRef.current) return;
      setHoverId(pickAt(nodes, e.clientX, e.clientY, { drill: e.altKey }));
    },
    [nodes],
  );

  const finishPress = useCallback(
    (e: MouseEvent) => {
      const press = pressRef.current;
      const dragged = marqueeRef.current;
      pressRef.current = null;
      marqueeRef.current = null;
      setMarquee(null);
      if (!press) return;

      if (press.dragging && dragged) {
        if (dragged.width < 1 || dragged.height < 1) return;
        openComposer(
          pickInRect(nodes, dragged),
          dragged,
          { x: e.clientX, y: e.clientY },
          Boolean(canCapture),
        );
        return;
      }

      // A click inside an existing note's region reopens it rather than starting a second one.
      for (const a of mine) {
        const rects = resolveRects(nodes, a.componentIds);
        const bounds = boundingRect(rects);
        if (
          bounds &&
          e.clientX >= bounds.left &&
          e.clientX <= bounds.right &&
          e.clientY >= bounds.top &&
          e.clientY <= bounds.bottom
        ) {
          openAnnotation(a, rects);
          return;
        }
      }

      const id = pickAt(nodes, e.clientX, e.clientY, { drill: e.altKey });
      if (!id) return;
      const rect = boundingRect(resolveRects(nodes, [id]));
      if (!rect) return;
      openComposer([id], rect, { x: e.clientX, y: e.clientY }, false);
    },
    [nodes, mine, canCapture, openComposer, openAnnotation],
  );

  /**
   * A press is followed on the window, not on the overlay, so a drag survives leaving the pane.
   *
   * Tracking it on the overlay meant the pointer crossing the panel's edge ended the gesture —
   * which is exactly the movement someone makes to select something sitting against that edge.
   * The rectangle is still clamped to the visible pane, because only what is on screen can be
   * captured; the pointer is free to go where it likes.
   */
  useEffect(() => {
    if (!pressing) return;

    const onMove = (e: MouseEvent) => {
      const press = pressRef.current;
      if (!press) return;
      if (
        Math.abs(e.clientX - press.x) > DRAG_THRESHOLD ||
        Math.abs(e.clientY - press.y) > DRAG_THRESHOLD
      ) {
        press.dragging = true;
      }
      if (!press.dragging) return;

      const view = scrollRef.current?.getBoundingClientRect();
      const clampX = (v: number) => (view ? Math.min(Math.max(v, view.left), view.right) : v);
      const clampY = (v: number) => (view ? Math.min(Math.max(v, view.top), view.bottom) : v);
      const x = clampX(e.clientX);
      const y = clampY(e.clientY);
      const rect = new DOMRect(
        Math.min(press.x, x),
        Math.min(press.y, y),
        Math.abs(x - press.x),
        Math.abs(y - press.y),
      );
      marqueeRef.current = rect;
      setMarquee(rect);
      setHoverId(null);
    };

    const onUp = (e: MouseEvent) => {
      setPressing(false);
      finishPress(e);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [pressing, finishPress]);

  const submit = useCallback(
    (text: string) => {
      if (!pending) return;
      const kinds = uncapturableKinds(nodes, pending.ids);
      const caveat =
        pending.shot && kinds.length > 0
          ? `\n\n(The screenshot cannot show the ${kinds.join(" and ")} in this region.)`
          : "";
      addAnnotation(sessionKey, {
        id: crypto.randomUUID(),
        kind: "canvas",
        surfaceId: surface.surfaceId,
        surfaceTitle: surface.title,
        componentIds: pending.ids,
        subtree: describeCanvasSubtree(surface, pending.ids),
        shotPath: pending.shot?.path,
        shotDataUrl: pending.shot?.dataUrl,
        text: text + caveat,
      });
      setPending(null);
    },
    [pending, nodes, addAnnotation, sessionKey, surface],
  );

  /** Reveal one note: page to its surface if needed, scroll to it, and open its bubble. */
  const goTo = useCallback(
    (id: string) => {
      const a = all.find((n) => n.id === id);
      if (!a) return;
      if (a.surfaceId !== surface.surfaceId) {
        // Paging the carousel is a round trip through the host, so the request is parked and
        // replayed once the surface it named is the one on screen.
        deferredGoToRef.current = id;
        onRequestSurface(a.surfaceId);
        return;
      }
      const scroller = scrollRef.current;
      const frame = frameRef.current;
      if (!scroller || !frame) return;
      // Measure here rather than trusting `nodes`: the observer that keeps it warm only
      // runs in annotation mode, so revealing a note from the list with the mode off — or
      // straight after re-opening the panel — would otherwise find nothing to scroll to.
      const measured = nodes.length > 0 ? nodes : readNodes(contentRef.current ?? frame);
      const bounds = boundingRect(resolveRects(measured, a.componentIds));
      if (!bounds) return;
      const top = bounds.top - frame.getBoundingClientRect().top;
      scroller.scrollTo({ top: Math.max(0, top - SCROLL_MARGIN), behavior: "smooth" });
      // Re-measure after the scroll so the bubble lands on the components, not where they were.
      requestAnimationFrame(() => {
        const settled = readNodes(contentRef.current ?? frame);
        setNodes(settled);
        openAnnotation(a, resolveRects(settled, a.componentIds));
      });
    },
    [all, surface.surfaceId, nodes, onRequestSurface, openAnnotation],
  );

  // The surface asked for has arrived — finish the reveal that paging interrupted. Waits for the
  // geometry of the new surface, or the note would be looked up against the old one's rects.
  useEffect(() => {
    const deferred = deferredGoToRef.current;
    if (!deferred || nodes.length === 0) return;
    deferredGoToRef.current = null;
    goTo(deferred);
  }, [nodes, goTo]);

  const navigate = useCallback(
    (delta: 1 | -1) => {
      if (mine.length === 0) return;
      const current = mine.findIndex((a) => a.id === viewingId);
      const from = current >= 0 ? current : delta === 1 ? -1 : 0;
      goTo(mine[(from + delta + mine.length) % mine.length].id);
    },
    [mine, viewingId, goTo],
  );

  // Escape unwinds one step at a time: the open bubble first, the mode only once nothing is open.
  // Capture phase with stopImmediatePropagation, because `PlanPermissionOverlay` also listens on
  // window for Escape and dismissing a bubble must not answer a plan. Keystrokes aimed at a field
  // are left alone — the composer cancels on its own Escape, and swallowing it here would close
  // the whole bubble instead of the edit.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
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
      e.stopImmediatePropagation();
      if (pending || viewingId) {
        setPending(null);
        setViewingId(null);
      } else {
        setActive(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, pending, viewingId]);

  const viewing = mine.find((a) => a.id === viewingId) ?? null;
  const hovered = hoverId ? nodes.find((n) => n.id === hoverId) : null;
  const shellStops = {
    onMouseUp: (e: React.MouseEvent) => e.stopPropagation(),
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    onMouseMove: (e: React.MouseEvent) => e.stopPropagation(),
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  };

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      {/* The bar sits on the right, where the plan and review tabs put theirs. The title keeps the
          left and gives up whatever width the bar needs. */}
      <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-border">
        <div className="flex-1 min-w-0 flex items-center">{header.title}</div>
        <div className="flex items-center gap-1 shrink-0">
          <AnnotationBar
            sessionKey={sessionKey}
            kind="canvas"
            onSend={onSend}
            sendDisabled={sendDisabled}
            onGoTo={goTo}
            activeId={viewingId}
            // `nodes` empty means "not measured yet", which is not the same as "the
            // components are gone" — greying every note on an unmeasured surface made
            // them look broken. Only an actual measurement can call one stale.
            isStale={(a) =>
              a.kind === "canvas" && a.surfaceId === surface.surfaceId && nodes.length > 0
                ? isStale(nodes, a.componentIds)
                : false
            }
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-pressed={active}
                  aria-label={active ? "Leave annotation mode" : "Annotate this canvas"}
                  onClick={() => setActive((v) => !v)}
                  className={cn(
                    "text-muted-foreground hover:text-foreground",
                    active && "bg-accent text-accent-foreground hover:text-accent-foreground",
                  )}
                />
              }
            >
              <SquareDashedMousePointer className="w-3.5 h-3.5" />
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {active ? "Leave annotation mode" : "Annotate this canvas"}
            </TooltipContent>
          </Tooltip>
          {header.actions}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar p-3">
        <div ref={frameRef} className="relative">
          {/* The capture target. The overlay below is deliberately a sibling: anything inside this
              element — the marquee, the outlines, the bubble — would be rasterised into the shot. */}
          <div ref={contentRef}>{children}</div>

          {active && (
            <div
              className="absolute inset-0 z-10 cursor-crosshair select-none"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              // Leaving the pane drops the hover highlight and nothing else: a press in flight is
              // owned by the window listeners, and cancelling it here is what made a selection
              // against the edge impossible to finish.
              onMouseLeave={() => setHoverId(null)}
            >
              {hovered && !pending && (
                <>
                  <div
                    className="absolute rounded-md bg-accent/10 border-[1.5px] border-dashed border-accent pointer-events-none"
                    style={toFrame(hovered.rect)}
                  />
                  <div
                    className="absolute px-1.5 py-px rounded-sm bg-accent text-accent-foreground text-[10px] font-mono whitespace-nowrap pointer-events-none"
                    style={{
                      left: toFrame(hovered.rect).left,
                      top: Math.max(0, toFrame(hovered.rect).top - 17),
                    }}
                  >
                    {hovered.kind} · {hovered.id}
                  </div>
                </>
              )}

              {marquee && (
                <>
                  {/* What the drag has caught so far, outlined as it is caught. Without this the
                      selection is only revealed after the comment is written, which is too late to
                      correct a drag that took one component too many. */}
                  {resolveRects(nodes, pickInRect(nodes, marquee)).map((rect, i) => (
                    <div
                      key={i}
                      className="absolute rounded-md bg-accent/15 border-[1.5px] border-accent pointer-events-none"
                      style={toFrame(rect)}
                    />
                  ))}
                  <div
                    className="absolute rounded bg-accent/8 border border-dashed border-accent pointer-events-none"
                    style={toFrame(marquee)}
                  />
                </>
              )}

              {mine.map((a) => {
                const bounds = boundingRect(resolveRects(nodes, a.componentIds));
                if (!bounds) return null;
                return (
                  <div
                    key={a.id}
                    className={cn(
                      "absolute rounded-md bg-accent/10 border-[1.5px] border-accent pointer-events-none",
                      a.id === viewingId && "bg-accent/20",
                    )}
                    style={toFrame(bounds)}
                  />
                );
              })}

              {pending && (
                <div
                  className="absolute rounded-md bg-accent/10 border-[1.5px] border-accent pointer-events-none"
                  style={toFrame(pending.rect)}
                />
              )}
            </div>
          )}

          {pending && (
            <div
              className="absolute z-20 rounded-lg border border-accent/50 bg-popover shadow-xl overflow-hidden"
              style={{ top: pending.top, left: pending.left, width: SHELL_WIDTH }}
              {...shellStops}
            >
              {pending.capture !== "off" && (
                <div className="px-3 pt-3">
                  {pending.shot ? (
                    <CaptureChip
                      dataUrl={pending.shot.dataUrl}
                      onRemove={() => setPending((prev) => (prev ? { ...prev, shot: null } : prev))}
                    />
                  ) : pending.capture === "failed" ? (
                    // Said out loud rather than left blank: the note is still worth sending, and
                    // silence here reads as a screenshot that was taken and then lost.
                    <p className="text-[11px] text-muted-foreground">
                      The region could not be captured, so the note will go without it.
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">Capturing region…</p>
                  )}
                </div>
              )}
              <div className="px-3 pt-2 pb-1">
                <AnnotationComposer bare onSubmit={submit} onCancel={() => setPending(null)} />
              </div>
            </div>
          )}

          {viewing && (
            <div
              className="absolute z-20 rounded-lg border border-accent/50 bg-popover shadow-xl overflow-hidden"
              style={{ top: viewPos.top, left: viewPos.left, width: SHELL_WIDTH }}
              {...shellStops}
            >
              <PendingCommentBlock
                bare
                imageDataUrl={viewing.shotDataUrl}
                onRemoveImage={() => clearAnnotationCapture(sessionKey, viewing.id)}
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
                {...(mine.length > 1 && {
                  onPrev: () => navigate(-1),
                  onNext: () => navigate(1),
                  position: [mine.indexOf(viewing) + 1, mine.length] as [number, number],
                })}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
