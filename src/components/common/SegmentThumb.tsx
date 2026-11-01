import { useLayoutEffect, useRef } from "react";

/**
 * The raised background of a segmented switch, one element that slides to whichever option is on.
 * Render it as the group's first child, in a `relative` group with `relative` options, so it paints
 * under them. It reads the choice from the DOM (`aria-pressed` or base-ui's `data-active`) so that
 * every kind of switch can share it and none has to tell it what changed.
 */
export function SegmentThumb() {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const thumb = ref.current;
    const group = thumb?.parentElement;
    if (!thumb || !group) return;
    const place = () => {
      const active = group.querySelector<HTMLElement>('[aria-pressed="true"],[data-active]');
      thumb.style.opacity = active ? "1" : "0";
      if (!active) return;
      // Rects and not offsets, which round: options often sit on fractions of a pixel. A dialog
      // still zooming in scales the rects, so they are scaled back by what its layout says.
      const box = group.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      const scale = box.width ? group.offsetWidth / box.width : 1;
      const x = (rect.left - box.left) * scale - group.clientLeft;
      const y = (rect.top - box.top) * scale - group.clientTop;
      thumb.style.transform = `translate(${x}px, ${y}px)`;
      thumb.style.width = `${rect.width * scale}px`;
      thumb.style.height = `${rect.height * scale}px`;
    };
    place();
    // Transitions start after the first placement, so a switch appears with its thumb in place.
    const frame = requestAnimationFrame(() => (thumb.dataset.ready = "true"));
    const choice = new MutationObserver(place);
    choice.observe(group, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-pressed", "data-active"],
    });
    const size = new ResizeObserver(place);
    size.observe(group);
    return () => {
      cancelAnimationFrame(frame);
      choice.disconnect();
      size.disconnect();
    };
  }, []);

  return (
    <span
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute top-0 left-0 rounded-lg bg-card/90 shadow-sm data-[ready=true]:transition-[transform,width,height] data-[ready=true]:duration-250 data-[ready=true]:ease-[cubic-bezier(0.2,0.8,0.2,1)]"
    />
  );
}
