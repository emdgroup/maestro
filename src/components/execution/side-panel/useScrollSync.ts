import { useEffect, useRef } from "react";
import { proportionalScrollTop } from "./file-edit-utils";

/**
 * Keep two scrollers in step, in both directions, while `enabled`.
 *
 * Takes the **elements**, not refs to them. An earlier version read `ref.current` inside the
 * effect and silently did nothing whenever an element arrived after the effect had run — which is
 * exactly what happens here, because CodeMirror's scroller only exists once the view is
 * constructed. Passing elements means the effect re-runs the moment either one appears, so there
 * is no ordering to get right. Hold them in state, not a ref, or nothing will re-render.
 *
 * The two things that make this non-trivial are both about not fighting itself: setting one
 * pane's `scrollTop` fires the other's scroll event, which would set the first one back, so a
 * short-lived flag marks a scroll as programmatic; and a wheel gesture fires far more often than
 * the screen repaints, so the write is deferred to the next frame.
 */
export function useScrollSync(enabled: boolean, a: HTMLElement | null, b: HTMLElement | null) {
  // Which element the last programmatic write targeted. Its next scroll event is the echo of that
  // write and must not be mirrored back.
  const echoRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !a || !b) return;

    function follow(from: HTMLElement, to: HTMLElement) {
      return () => {
        if (echoRef.current === from) {
          echoRef.current = null;
          return;
        }
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null;
          const next = proportionalScrollTop({
            scrollTop: from.scrollTop,
            scrollHeight: from.scrollHeight,
            clientHeight: from.clientHeight,
            targetScrollHeight: to.scrollHeight,
            targetClientHeight: to.clientHeight,
          });
          if (Math.abs(to.scrollTop - next) < 1) return;
          echoRef.current = to;
          to.scrollTop = next;
        });
      };
    }

    const onFirst = follow(a, b);
    const onSecond = follow(b, a);
    a.addEventListener("scroll", onFirst, { passive: true });
    b.addEventListener("scroll", onSecond, { passive: true });

    return () => {
      a.removeEventListener("scroll", onFirst);
      b.removeEventListener("scroll", onSecond);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      echoRef.current = null;
    };
  }, [enabled, a, b]);
}
