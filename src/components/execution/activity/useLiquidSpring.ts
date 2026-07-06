import { useState, useRef, useEffect } from "react";
import {
  stateFor,
  FILL_COLOR,
  FILL_COLOR_LIGHT_CRITICAL,
  RING_COLOR,
  RING_OP_LIGHT,
} from "./liquid-indicator-data";
import type { FillState } from "./liquid-indicator-data";

interface AnimState {
  current: number;
  target: number;
  velocity: number;
  raf: number | null;
  lastTs: number | null;
  prevState: FillState;
}

/**
 * Spring animation for the liquid context indicator.
 * Directly mutates the provided DOM refs to avoid React re-renders in the hot loop.
 * Returns fillState (React state) for use in the popover UI.
 */
export function useLiquidSpring(
  ratio: number,
  waveGroupRef: React.RefObject<SVGGElement | null>,
  fillPathRef: React.RefObject<SVGPathElement | null>,
  ringRef: React.RefObject<SVGCircleElement | null>,
  lensRef: React.RefObject<HTMLSpanElement | null>,
  isDarkRef: React.MutableRefObject<boolean>,
): {
  fillState: FillState;
  animRef: React.MutableRefObject<AnimState>;
} {
  // Spring state — initialized with current ratio so the mount effect needs no ratio dep
  const animRef = useRef<AnimState>({
    current: ratio,
    target: ratio,
    velocity: 0,
    raf: null,
    lastTs: null,
    prevState: "normal",
  });
  // tickRef lets the ratio-change effect restart the RAF after the setup effect defines tick
  const tickRef = useRef<((ts: number) => void) | null>(null);

  const [fillState, setFillState] = useState<FillState>(() => stateFor(ratio));

  // Setup: define applyFrame + tick once after mount, snap to initial ratio
  useEffect(() => {
    const anim = animRef.current;

    function applyFrame(r: number) {
      const wg = waveGroupRef.current;
      const fp = fillPathRef.current;
      const rg = ringRef.current;
      const ln = lensRef.current;
      if (!wg || !fp || !rg || !ln) return;

      // SVG transform attribute positions the wave surface (0=full top, 20=empty)
      wg.setAttribute("transform", `translate(0,${(1 - r) * 20})`);

      const state = stateFor(r);
      const isDark = isDarkRef.current;

      // Use .style (not setAttribute) so CSS custom properties resolve correctly
      fp.style.fill =
        !isDark && state === "critical" ? FILL_COLOR_LIGHT_CRITICAL : FILL_COLOR[state];
      rg.style.stroke = RING_COLOR[state];
      rg.style.strokeOpacity = String(isDark ? 0.2 : RING_OP_LIGHT[state]);

      if (state !== anim.prevState) {
        setFillState(state);
        anim.prevState = state;
      }
    }

    function tick(ts: number) {
      const dt = anim.lastTs ? Math.min((ts - anim.lastTs) / 1000, 0.05) : 0.016;
      anim.lastTs = ts;

      const force = (anim.target - anim.current) * 18;
      anim.velocity = (anim.velocity + force * dt) * Math.pow(0.72, dt * 60);
      anim.current += anim.velocity * dt;
      anim.current = Math.max(0, Math.min(1, anim.current));
      applyFrame(anim.current);

      if (Math.abs(anim.target - anim.current) < 0.01 && Math.abs(anim.velocity) < 0.01) {
        anim.current = anim.target;
        applyFrame(anim.current);
        anim.raf = null;
        anim.lastTs = null;
        return;
      }
      anim.raf = requestAnimationFrame(tick);
    }

    tickRef.current = tick;

    // animRef was initialized with the initial ratio — snap DOM to match without animation
    applyFrame(anim.current);

    return () => {
      if (anim.raf !== null) {
        cancelAnimationFrame(anim.raf);
        anim.raf = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Kick spring toward new ratio whenever usage changes
  useEffect(() => {
    const anim = animRef.current;
    anim.velocity += (ratio - anim.current) * 4.0;
    anim.target = ratio;

    if (!anim.raf && tickRef.current) {
      anim.lastTs = null;
      anim.raf = requestAnimationFrame(tickRef.current);
    }
  }, [ratio]);

  return { fillState, animRef };
}
