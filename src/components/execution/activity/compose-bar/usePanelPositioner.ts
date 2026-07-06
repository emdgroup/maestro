import { useState, useLayoutEffect } from "react";
import type { RefObject } from "react";

export function usePanelPositioner(
  active: boolean,
  containerRef: RefObject<HTMLDivElement | null>,
): { top: number; left: number; width: number } | null {
  const [panelPos, setPanelPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!active) {
      setPanelPos(null);
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setPanelPos({ top: rect.top, left: rect.left, width: rect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", update, true);
    };
  }, [active, containerRef]);

  return panelPos;
}
