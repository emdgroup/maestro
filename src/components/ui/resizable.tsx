import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "@/lib/utils";

function ResizablePanelGroup({ className, ...props }: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn("flex h-full w-full aria-[orientation=vertical]:flex-col", className)}
      {...props}
    />
  );
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

/**
 * Takes everything outside the viewport out of a drag, and puts it back when the drag ends.
 *
 * Content whose layout depends on its own width — a wrapped, un-virtualized diff is the expensive
 * case — otherwise relayouts in full on every pointer frame, and the drag falls a long way behind
 * the cursor. What the user can see still follows the drag live; only what they cannot is skipped.
 *
 * An element carrying `data-freeze-layout` is either off screen, in which case its layout is
 * skipped at exactly the size it already has, or on screen, in which case the same is done to its
 * units — the rows named by the attribute's value — one viewport's worth either side of what is
 * visible. Hidden rows leave the element short by their height, so it is padded by as much, which
 * is what keeps the scroller's geometry and everything below the drag where they were.
 *
 * Measured over a three-file review, 8600 wrapped rows, scrolled into the middle of the large one:
 * 183ms a frame before, 0.2ms after, for 73ms of measuring when the drag starts and one full
 * relayout on release.
 *
 * Reads come before writes throughout, so the pass forces layout once rather than once per
 * element. Opting in belongs to whatever is slow — the panels know nothing about it.
 */
function freezeLayout() {
  const viewport = window.innerHeight;
  // A viewport of slack either side: what is visible rewraps as the drag goes, and the content
  // below it moves by the difference. Without the margin a row that was just off the bottom edge
  // can be pulled into view while it is hidden, which reads as the diff running out early.
  const isOutside = (rect: DOMRect) => rect.bottom <= -viewport || rect.top >= viewport * 2;

  const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-freeze-layout]"));
  const plans = targets.map((element) => {
    const rect = element.getBoundingClientRect();
    const unitSelector = element.dataset.freezeLayout;
    const units =
      isOutside(rect) || !unitSelector
        ? []
        : Array.from(element.querySelectorAll<HTMLElement>(unitSelector));
    return { element, rect, units, unitRects: units.map((unit) => unit.getBoundingClientRect()) };
  });

  const hidden: HTMLElement[] = [];
  plans.forEach(({ element, rect, units, unitRects }) => {
    if (isOutside(rect)) {
      element.style.containIntrinsicSize = `${rect.width}px ${rect.height}px`;
      element.style.contentVisibility = "hidden";
      return;
    }
    let above = 0;
    let below = 0;
    units.forEach((unit, i) => {
      const unitRect = unitRects[i];
      if (!isOutside(unitRect)) return;
      if (unitRect.bottom <= 0) above += unitRect.height;
      else below += unitRect.height;
      unit.style.display = "none";
      hidden.push(unit);
    });
    element.style.paddingTop = `${above}px`;
    element.style.paddingBottom = `${below}px`;
  });

  const stop = () => {
    targets.forEach((element) => {
      element.style.contentVisibility = "";
      element.style.containIntrinsicSize = "";
      element.style.paddingTop = "";
      element.style.paddingBottom = "";
    });
    hidden.forEach((unit) => {
      unit.style.display = "";
    });
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
  };
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
}

function ResizableHandle({
  withHandle,
  className,
  onPointerDown,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (!props.disabled) freezeLayout();
      }}
      className={cn(
        "relative flex w-px items-center justify-center bg-border ring-offset-background transition-colors hover:bg-accent/60 after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-2 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        className,
      )}
      {...props}
    >
      {withHandle && <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />}
    </ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
