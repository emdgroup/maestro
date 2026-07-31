import { useEffect, useRef, useState } from "react";

/**
 * Wheel-to-horizontal scrolling plus edge-fade masks for an `overflow-x-auto` strip.
 * Pass whatever changes the content width (e.g. item count) as `dep` so the
 * fades re-measure; container resizes are picked up by a ResizeObserver.
 */
export function useHorizontalScrollFade<T extends HTMLElement>(dep?: unknown) {
  const ref = useRef<T>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      setCanScrollLeft(el.scrollLeft > 2);
      setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
    };
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const raf = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [dep]);

  const f = "3rem";
  const maskImage =
    canScrollLeft && canScrollRight
      ? `linear-gradient(to right, transparent, black ${f}, black calc(100% - ${f}), transparent)`
      : canScrollLeft
        ? `linear-gradient(to right, transparent, black ${f})`
        : canScrollRight
          ? `linear-gradient(to left, transparent, black ${f})`
          : undefined;

  return {
    ref,
    maskStyle: maskImage ? { maskImage, WebkitMaskImage: maskImage } : undefined,
  };
}
