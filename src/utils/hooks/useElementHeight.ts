import { useEffect, useState, type RefObject } from "react";

/**
 * The border-box height of the element in `ref`, kept current with a ResizeObserver, and 0 while
 * there is no element. A zero reading is ignored, since a hidden element reports one. A change of
 * `layout` means the element may have been swapped for another, so the observer re-attaches.
 */
export function useElementHeight(ref: RefObject<HTMLElement | null>, layout: string) {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      setHeight(0);
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      if (h > 0) setHeight(h);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, layout]);
  return height;
}
