import { useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import { ZoomIn, ZoomOut, Fullscreen, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils.ts";

interface ZoomableContentProps {
  children: ReactNode;
  lightboxContent?: ReactNode;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;
const ZOOM_STEP = 0.25;
const IDLE_TIMEOUT_MS = 2000;

export function ZoomableContent({
  children,
  lightboxContent,
  className,
  disabled,
  ariaLabel,
}: ZoomableContentProps) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const draggingRef = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const naturalSize = useRef({ width: 0, height: 0 });
  // Refs to current pan/zoom — read during drag without triggering re-renders
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);

  const clampZoom = useCallback((z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)), []);

  function resetState() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  function handleOpenChange(val: boolean) {
    if (!val) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      draggingRef.current = false;
      setIsDragging(false);
    }
    setOpen(val);
  }

  const startIdleTimer = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setControlsVisible(false), IDLE_TIMEOUT_MS);
  }, []);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    startIdleTimer();
  }, [startIdleTimer]);

  const keepControlsVisible = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setControlsVisible(true);
  }, []);

  const doFitToView = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const { width: cw, height: ch } = naturalSize.current;
    if (!cw || !ch) return;
    const vpW = vp.clientWidth * 0.9;
    const vpH = vp.clientHeight * 0.9;
    const fit = clampZoom(Math.min(vpW / cw, vpH / ch));
    setPan({ x: 0, y: 0 });
    setZoom(fit);
  }, [clampZoom]);

  // Measure natural size once after open (double rAF ensures React committed + browser laid out),
  // then immediately fit. Subsequent fitToView calls use stored dimensions — no DOM mutation needed.
  useEffect(() => {
    if (!open) return;
    setControlsVisible(true);
    startIdleTimer();
    let raf1: number;
    let raf2: number;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const ct = contentRef.current;
        if (!ct) return;
        const saved = ct.style.transform;
        ct.style.transform = "scale(1) translate(0px, 0px)";
        const rect = ct.getBoundingClientRect();
        ct.style.transform = saved;
        naturalSize.current = { width: rect.width, height: rect.height };
        doFitToView();
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [open, startIdleTimer, doFitToView]);

  function applyZoom(next: number) {
    setZoom(clampZoom(next));
  }

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const vp = viewportRef.current;
      if (!vp) return;
      const rect = vp.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      setZoom((prev) => {
        const next = clampZoom(prev + (e.deltaY > 0 ? -0.12 : 0.12));
        const scale = next / prev;
        setPan((p) => ({ x: cx - scale * (cx - p.x), y: cy - scale * (cy - p.y) }));
        return next;
      });
      showControls();
    },
    [clampZoom, showControls],
  );

  const handlePointerDown = useCallback((e: PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-lightbox-controls]")) return;
    e.preventDefault();
    draggingRef.current = true;
    setIsDragging(true);
    lastMouse.current = { x: e.clientX, y: e.clientY };

    const onMove = (ev: PointerEvent) => {
      panRef.current = {
        x: panRef.current.x + ev.clientX - lastMouse.current.x,
        y: panRef.current.y + ev.clientY - lastMouse.current.y,
      };
      lastMouse.current = { x: ev.clientX, y: ev.clientY };
      // Direct DOM update — avoids React re-renders which kill pointermove in React 19
      if (contentRef.current) {
        contentRef.current.style.transform = `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${zoomRef.current})`;
      }
    };

    const onUpOrCancel = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUpOrCancel);
      document.removeEventListener("pointercancel", onUpOrCancel);
      draggingRef.current = false;
      setIsDragging(false);
      setPan({ ...panRef.current }); // sync ref back to React state
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUpOrCancel);
    document.addEventListener("pointercancel", onUpOrCancel);
  }, []);

  const viewportCallbackRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (viewportRef.current) {
        viewportRef.current.removeEventListener("wheel", handleWheel);
        viewportRef.current.removeEventListener("pointerdown", handlePointerDown);
      }
      viewportRef.current = el;
      if (el) {
        el.addEventListener("wheel", handleWheel, { passive: false });
        el.addEventListener("pointerdown", handlePointerDown, { passive: false });
      }
    },
    [handleWheel, handlePointerDown],
  );

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      showControls();
      if (e.key === "Escape") {
        handleOpenChange(false);
        return;
      }
      if (e.key === "0") {
        resetState();
        return;
      }
      if (e.key === "=" || e.key === "+") {
        setZoom((z) => clampZoom(z + ZOOM_STEP));
        return;
      }
      if (e.key === "-") {
        setZoom((z) => clampZoom(z - ZOOM_STEP));
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        doFitToView();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, showControls, clampZoom, doFitToView]);

  const cursor = isDragging ? "cursor-grabbing" : "cursor-grab";

  // Assign refs inline during render so drag handlers always see the latest values.
  panRef.current = pan;
  zoomRef.current = zoom;

  return (
    <>
      <div
        role="button"
        tabIndex={disabled ? undefined : 0}
        aria-label={`Open ${ariaLabel ?? "content"} in lightbox`}
        className={cn(
          "relative group/zoomable rounded-sm",
          !disabled && "cursor-zoom-in",
          className,
        )}
        onClick={() => !disabled && setOpen(true)}
        onKeyDown={(e) => {
          if (!disabled && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
        {!disabled && (
          <div className="absolute inset-0 rounded-sm ring-inset ring-0 group-hover/zoomable:ring-2 ring-accent/25 pointer-events-none transition-all duration-150" />
        )}
      </div>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="w-[95vw] h-[90vh] max-w-[95vw] sm:max-w-[95vw] max-h-[90vh] rounded-xl p-0 ring-1 ring-border shadow-2xl bg-background/95 backdrop-blur-sm flex flex-col overflow-hidden"
        >
          <DialogTitle className="sr-only">{ariaLabel ?? "Zoomed content"}</DialogTitle>

          {/* Viewport */}
          <div
            ref={viewportCallbackRef}
            className={cn(
              "flex-1 overflow-hidden flex items-center justify-center select-none",
              cursor,
            )}
            style={{ touchAction: "none" }}
            onPointerMove={() => {
              if (!draggingRef.current) showControls();
            }}
          >
            <div
              ref={contentRef}
              onDragStart={(e) => e.preventDefault()}
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: "center center",
                transition: isDragging ? "none" : "transform 0.06s ease-out",
              }}
            >
              {lightboxContent ?? children}
            </div>
          </div>

          {/* Close button */}
          <div
            data-lightbox-controls
            onMouseEnter={keepControlsVisible}
            onMouseLeave={showControls}
            className={cn(
              "absolute top-3 right-3 transition-opacity duration-[250ms]",
              controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none",
            )}
          >
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => handleOpenChange(false)}
              aria-label="Close"
            >
              <X />
            </Button>
          </div>

          {/* Floating pill */}
          <div
            data-lightbox-controls
            onMouseEnter={keepControlsVisible}
            onMouseLeave={showControls}
            className={cn(
              "absolute bottom-5 left-1/2 -translate-x-1/2 transition-opacity duration-[250ms]",
              controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none",
            )}
          >
            <div className="flex items-center gap-0.5 rounded-full border border-border bg-background/88 px-2 py-1.5 shadow-lg backdrop-blur-xl">
              <Button
                variant="ghost"
                size="icon-xs"
                className="rounded-full"
                onClick={() => applyZoom(zoom - ZOOM_STEP)}
                aria-label="Zoom out"
              >
                <ZoomOut />
              </Button>

              <Tooltip>
                <TooltipTrigger
                  type="button"
                  onClick={resetState}
                  className="min-w-[3rem] text-center font-mono text-[11px] text-muted-foreground tabular-nums select-none hover:text-foreground transition-colors cursor-pointer rounded px-1"
                  aria-label="Reset to 100%"
                >
                  {Math.round(zoom * 100)}%
                </TooltipTrigger>
                <TooltipContent>Reset to 100%</TooltipContent>
              </Tooltip>

              <Button
                variant="ghost"
                size="icon-xs"
                className="rounded-full"
                onClick={() => applyZoom(zoom + ZOOM_STEP)}
                aria-label="Zoom in"
              >
                <ZoomIn />
              </Button>

              <div className="mx-1.5 h-4 w-px bg-border" />

              <Button
                variant="ghost"
                size="icon-xs"
                className="rounded-full"
                onClick={doFitToView}
                aria-label="Fit to view"
              >
                <Fullscreen />
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
