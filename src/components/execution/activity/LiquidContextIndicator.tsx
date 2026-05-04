import { useState, useRef, useEffect, useId } from "react";
import { cn } from "@/lib";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Button } from "@/ui/button";
import type { UsageState } from "./types";

type FillState = "critical" | "warning" | "amber" | "normal";

const FILL_COLOR: Record<FillState, string> = {
  critical: "var(--destructive)",
  warning: "var(--warning)",
  amber: "var(--warning)",
  normal: "var(--success)",
};

const RING_COLOR: Record<FillState, string> = {
  critical: "var(--destructive)",
  warning: "var(--warning)",
  amber: "var(--border)",
  normal: "var(--border)",
};

const RING_OP: Record<FillState, number> = {
  critical: 0.5,
  warning: 0.5,
  amber: 1,
  normal: 1,
};

const LENS_GLOW: Record<FillState, string> = {
  critical:
    "inset 0 0 0 1.5px rgba(255,255,255,0.1), inset 0 1.5px 3px 0 rgba(255,255,255,0.15), inset 0 -1.5px 3px 0 rgba(0,0,0,0.3), 0 0 14px 3px rgba(239,68,68,0.14), 0 0 1px 0 rgba(255,255,255,0.06)",
  warning:
    "inset 0 0 0 1.5px rgba(255,255,255,0.12), inset 0 1.5px 3px 0 rgba(255,255,255,0.18), inset 0 -1.5px 3px 0 rgba(0,0,0,0.3), 0 0 12px 3px rgba(245,158,11,0.1), 0 0 1px 0 rgba(255,255,255,0.06)",
  amber:
    "inset 0 0 0 1.5px rgba(255,255,255,0.14), inset 0 1.5px 3px 0 rgba(255,255,255,0.2), inset 0 -1.5px 3px 0 rgba(0,0,0,0.3), 0 0 12px 2px rgba(99,102,241,0.08), 0 0 1px 0 rgba(255,255,255,0.08)",
  normal:
    "inset 0 0 0 1.5px rgba(255,255,255,0.14), inset 0 1.5px 3px 0 rgba(255,255,255,0.2), inset 0 -1.5px 3px 0 rgba(0,0,0,0.3), 0 0 12px 2px rgba(99,102,241,0.08), 0 0 1px 0 rgba(255,255,255,0.08)",
};

function stateFor(r: number): FillState {
  if (r >= 0.85) return "critical";
  if (r >= 0.75) return "warning";
  if (r >= 0.6) return "amber";
  return "normal";
}

// Wave path: 3 periods (x=-20 to x=40), amplitude ±1.1 SVG units.
// SMIL scrolls one period (20 units) left → seamless loop.
const WAVE_FILL =
  "M-20 0 Q-16 -1.1 -10 0 Q-4 1.1 0 0 Q4 -1.1 10 0 Q16 1.1 20 0 Q24 -1.1 30 0 Q36 1.1 40 0 L40 20 L-20 20 Z";
const WAVE_LINE =
  "M-20 0 Q-16 -1.1 -10 0 Q-4 1.1 0 0 Q4 -1.1 10 0 Q16 1.1 20 0 Q24 -1.1 30 0 Q36 1.1 40 0";

export function LiquidContextIndicator({ usage, onCompact }: { usage: UsageState; onCompact?: () => void }) {
  const clipId = useId();
  const ratio = Math.min(1, Math.max(0, usage.size > 0 ? usage.used / usage.size : 0));

  // DOM refs — mutated directly by the spring loop, no React re-renders
  const waveGroupRef = useRef<SVGGElement>(null);
  const fillPathRef = useRef<SVGPathElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  const lensRef = useRef<HTMLSpanElement>(null);

  // Spring state
  const animRef = useRef({
    current: 0,
    target: 0,
    velocity: 0,
    raf: null as number | null,
    lastTs: null as number | null,
    prevState: "normal" as FillState,
  });
  // tickRef lets the ratio-change effect restart the RAF after the setup effect defines tick
  const tickRef = useRef<((ts: number) => void) | null>(null);

  // React state only for discrete pulse threshold changes (≤4 transitions total per session)
  const [pulseStyle, setPulseStyle] = useState<React.CSSProperties | undefined>(undefined);

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
      // Use .style (not setAttribute) so CSS custom properties resolve correctly
      fp.style.fill = FILL_COLOR[state];
      rg.style.stroke = RING_COLOR[state];
      rg.style.strokeOpacity = String(RING_OP[state]);

      if (state !== anim.prevState) {
        ln.style.boxShadow = LENS_GLOW[state];
        setPulseStyle(
          state === "critical"
            ? { animation: "ctx-pulse 1.4s ease-in-out infinite" }
            : state === "warning"
              ? { animation: "ctx-pulse 2s ease-in-out infinite" }
              : undefined,
        );
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

    // Snap to initial ratio without animation
    anim.current = ratio;
    anim.target = ratio;
    applyFrame(ratio);

    return () => {
      if (anim.raf !== null) {
        cancelAnimationFrame(anim.raf);
        anim.raf = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const pct = Math.round(ratio * 100);

  return (
    <Popover>
      <PopoverTrigger className="inline-flex items-center">
        <span className="relative w-4 h-4 origin-center cursor-pointer" style={pulseStyle}>
            <svg viewBox="0 0 20 20" className="w-full h-full block">
              <defs>
                <clipPath id={clipId}>
                  <circle cx="10" cy="10" r="7.5" />
                </clipPath>
              </defs>
              {/* Ring — stroke controlled by applyFrame via .style */}
              <circle
                ref={ringRef}
                cx="10"
                cy="10"
                r="8.5"
                fill="none"
                strokeWidth="1.5"
                style={{ stroke: "var(--border)", strokeOpacity: 1 }}
              />
              {/* clip-path on static wrapper — never moves (CSS transform + clip-path on same element is unreliable) */}
              <g clipPath={`url(#${clipId})`}>
                {/* wave-group transform ATTRIBUTE (not CSS) set by JS — positions fill level */}
                <g ref={waveGroupRef} transform="translate(0,20)">
                  <path ref={fillPathRef} d={WAVE_FILL} style={{ fill: "var(--success)" }}>
                    <animateTransform
                      attributeName="transform"
                      type="translate"
                      from="0,0"
                      to="-20,0"
                      dur="3.2s"
                      repeatCount="indefinite"
                    />
                  </path>
                  <path d={WAVE_LINE} fill="none" stroke="white" strokeWidth="0.7" opacity="0.35">
                    <animateTransform
                      attributeName="transform"
                      type="translate"
                      from="0,0"
                      to="-20,0"
                      dur="3.2s"
                      repeatCount="indefinite"
                    />
                  </path>
                </g>
              </g>
            </svg>
            {/* Glass lens overlay */}
            <span
              ref={lensRef}
              className={cn(
                "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-3.75 rounded-full pointer-events-none",
                "backdrop-blur-[0.4px] backdrop-brightness-[1.18] backdrop-saturate-[1.35]",
                "before:absolute before:-inset-px before:rounded-full",
                "before:[background:conic-gradient(from_200deg,rgba(99,102,241,0.15),rgba(168,85,247,0.1),rgba(236,72,153,0.08),rgba(251,191,36,0.05),rgba(34,197,94,0.08),rgba(59,130,246,0.1),rgba(99,102,241,0.15))]",
                "before:[mask:radial-gradient(circle,transparent_60%,black_62%,black_100%)]",
                "after:absolute after:w-[30%] after:h-[16%] after:top-[16%] after:left-[22%] after:rounded-full after:bg-white/[0.28] after:blur-[2px]",
              )}
              style={{
                background:
                  "radial-gradient(ellipse 60% 40% at 35% 25%, rgba(255,255,255,0.2) 0%, transparent 70%), radial-gradient(circle at 50% 50%, rgba(99,102,241,0.05) 0%, rgba(99,102,241,0.02) 60%, transparent 100%)",
                boxShadow: LENS_GLOW.normal,
              }}
            />
          </span>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-48 p-3 flex flex-col gap-2">
          <div className="text-xs text-muted-foreground">
            Context{usage.size > 1 ? `: ${pct}%` : ""}
          </div>
          {onCompact && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs w-full"
              onClick={onCompact}
            >
              Compact
            </Button>
          )}
        </PopoverContent>
      </Popover>
  );
}
