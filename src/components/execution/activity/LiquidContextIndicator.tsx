import { useState, useRef, useEffect, useId } from "react";
import { cn } from "@/lib/ui-utils";
import { humanizeTokenCount } from "@/lib/format-utils";
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

// Softened critical for light theme — less violent red
const FILL_COLOR_LIGHT_CRITICAL = "oklch(55% 0.14 25)";

const RING_COLOR: Record<FillState, string> = {
  critical: "var(--destructive)",
  warning: "var(--warning)",
  amber: "var(--border)",
  normal: "var(--border)",
};

// Light: per-state opacity; Dark: always 0.2 (ring too prominent otherwise)
const RING_OP_LIGHT: Record<FillState, number> = {
  critical: 0.5,
  warning: 0.5,
  amber: 1,
  normal: 1,
};

const LENS_STYLE = {
  light: {
    backdropFilter: "blur(0.6px) brightness(1.20) saturate(1.40)",
    background: [
      "radial-gradient(ellipse 60% 36% at 35% 25%, rgba(255,255,255,0.50) 0%, transparent 70%)",
      "radial-gradient(circle at 50% 55%, rgba(255,255,255,0.20) 0%, rgba(255,255,255,0.10) 45%, transparent 70%)",
      "radial-gradient(circle at 50% 50%, rgba(0,0,0,0.14) 0%, rgba(0,0,0,0.07) 55%, transparent 100%)",
    ].join(", "),
    boxShadow: [
      "inset 0 0 20px 1px rgba(255,255,255,0.30)",
      "inset 0 0 3px 0 rgba(0,0,0,0.14)",
      "0 0 8px 2px rgba(99,102,241,0.06)",
    ].join(", "),
  },
  dark: {
    backdropFilter: "blur(0.6px) brightness(0.90) saturate(1.40)",
    background: [
      "radial-gradient(ellipse 60% 36% at 35% 25%, rgba(255,255,255,0.30) 0%, transparent 70%)",
      "radial-gradient(circle at 50% 50%, rgba(0,0,0,0.14) 0%, rgba(0,0,0,0.07) 55%, transparent 100%)",
    ].join(", "),
    boxShadow: ["inset 0 0 20px 1px rgba(0,0,0,0.30)", "0 0 8px 2px rgba(99,102,241,0.06)"].join(
      ", ",
    ),
  },
};

const TIPS: Record<FillState, { icon: string; text: string }> = {
  normal: { icon: "✓", text: "Plenty of room. Agent has full context for complex reasoning." },
  amber: { icon: "→", text: "Filling up. Consider compacting if task will run longer." },
  warning: {
    icon: "⚠",
    text: "Running low. Agent may lose early context soon. Compact recommended.",
  },
  critical: {
    icon: "⚡",
    text: "Near limit. Agent will auto-compact soon. Compact now to stay in control.",
  },
};

const TIP_STYLE: Record<FillState, string> = {
  normal: "bg-success/8 border border-success/15",
  amber: "bg-warning/8 border border-warning/15",
  warning: "bg-warning/12 border border-warning/20",
  critical: "bg-destructive/10 border border-destructive/20",
};

const DOT_COLOR: Record<FillState, string> = {
  normal: "bg-success",
  amber: "bg-warning",
  warning: "bg-warning",
  critical: "bg-destructive shadow-[0_0_6px_var(--color-destructive)]",
};

const PCT_COLOR: Record<FillState, string> = {
  normal: "text-success",
  amber: "text-warning",
  warning: "text-warning",
  critical: "text-destructive",
};

const PROGRESS_COLOR: Record<FillState, string> = {
  normal: "bg-success",
  amber: "bg-warning",
  warning: "bg-warning",
  critical: "bg-destructive",
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

export function LiquidContextIndicator({
  usage,
  onCompact,
}: {
  usage: UsageState;
  onCompact?: () => void;
}) {
  const clipId = useId();
  const ratio = Math.min(1, Math.max(0, usage.size > 0 ? usage.used / usage.size : 0));

  // DOM refs — mutated directly by the spring loop, no React re-renders
  const waveGroupRef = useRef<SVGGElement>(null);
  const fillPathRef = useRef<SVGPathElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  const lensRef = useRef<HTMLSpanElement>(null);
  const isDarkRef = useRef(document.documentElement.classList.contains("dark"));

  // Spring state — initialized with current ratio so the mount effect needs no ratio dep
  const animRef = useRef({
    current: ratio,
    target: ratio,
    velocity: 0,
    raf: null as number | null,
    lastTs: null as number | null,
    prevState: "normal" as FillState,
  });
  // tickRef lets the ratio-change effect restart the RAF after the setup effect defines tick
  const tickRef = useRef<((ts: number) => void) | null>(null);

  const [fillState, setFillState] = useState<FillState>(() => stateFor(ratio));

  const [open, setOpen] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether hover opened the popover so mouse-leave can close it
  const openedByHoverRef = useRef(false);

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
  }, []);

  // Apply theme-aware lens style + re-run applyFrame when dark/light class changes
  useEffect(() => {
    function applyLensTheme() {
      const ln = lensRef.current;
      if (!ln) return;
      const style = isDarkRef.current ? LENS_STYLE.dark : LENS_STYLE.light;
      ln.style.backdropFilter = style.backdropFilter;
      ln.style.background = style.background;
      ln.style.boxShadow = style.boxShadow;
    }

    applyLensTheme();

    const observer = new MutationObserver(() => {
      isDarkRef.current = document.documentElement.classList.contains("dark");
      applyLensTheme();
      // Re-apply fill + ring opacity for new theme
      const anim = animRef.current;
      const state = stateFor(anim.current);
      const fp = fillPathRef.current;
      const rg = ringRef.current;
      if (fp)
        fp.style.fill =
          !isDarkRef.current && state === "critical"
            ? FILL_COLOR_LIGHT_CRITICAL
            : FILL_COLOR[state];
      if (rg) rg.style.strokeOpacity = String(isDarkRef.current ? 0.2 : RING_OP_LIGHT[state]);
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
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

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  function handleMouseEnter() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      openedByHoverRef.current = true;
      setOpen(true);
    }, 1000);
  }

  function handleMouseLeave() {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (openedByHoverRef.current) {
      hoverTimerRef.current = setTimeout(() => {
        hoverTimerRef.current = null;
        openedByHoverRef.current = false;
        setOpen(false);
      }, 150);
    }
  }

  function handlePopoverMouseEnter() {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }

  function handlePopoverMouseLeave() {
    if (openedByHoverRef.current) {
      openedByHoverRef.current = false;
      setOpen(false);
    }
  }

  function handleOpenChange(newOpen: boolean) {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    openedByHoverRef.current = false;
    setOpen(newOpen);
  }

  const pct = Math.round(ratio * 100);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        className="inline-flex items-center"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <span className="relative w-8 h-8 origin-center cursor-pointer">
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
              strokeWidth="0.7"
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
          {/* Glass lens overlay — styles applied by JS (theme-aware) */}
          <span
            ref={lensRef}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-7.5 rounded-full pointer-events-none"
          />
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={16}
        onMouseEnter={handlePopoverMouseEnter}
        onMouseLeave={handlePopoverMouseLeave}
        className={cn(
          "w-64 p-3.5 flex flex-col gap-3",
          "backdrop-blur-[4px] bg-popover/60 border-border/30",
          "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_-1px_0_0_rgba(0,0,0,0.15)]",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold flex items-center gap-1.5">
            <span className={cn("w-1.5 h-1.5 rounded-full inline-block", DOT_COLOR[fillState])} />
            Context Window
          </span>
          <span
            className={cn("text-lg font-bold tabular-nums tracking-tight", PCT_COLOR[fillState])}
          >
            {pct}%
          </span>
        </div>

        {/* Progress bar */}
        <div className="w-full h-1 rounded-full bg-white/6 overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
              PROGRESS_COLOR[fillState],
            )}
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* Token info */}
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>
            {humanizeTokenCount(usage.used)} / {humanizeTokenCount(usage.size)} tokens
          </span>
          {usage.cost && <span>${usage.cost.amount.toFixed(2)}</span>}
        </div>

        {/* Contextual tip */}
        <div
          className={cn(
            "flex gap-2 px-2.5 py-2 rounded-md text-[11px] leading-relaxed",
            TIP_STYLE[fillState],
          )}
        >
          <span className="flex-shrink-0 mt-px">{TIPS[fillState].icon}</span>
          <span>{TIPS[fillState].text}</span>
        </div>

        {onCompact && (
          <>
            <div className="h-px bg-border/50" />

            <Button
              variant="outline"
              size="sm"
              className={cn(
                "h-7 text-xs w-full",
                fillState === "critical" &&
                  "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15 font-semibold",
              )}
              onClick={onCompact}
            >
              {fillState === "critical" ? "Compact now" : "Compact context"}
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
