import { useState, useRef, useEffect, useId } from "react";
import { cn } from "@/lib/utils.ts";
import { humanizeTokenCount } from "@/lib/format-utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Button } from "@/ui/button";
import type { UsageState } from "./types";
import {
  FILL_COLOR,
  FILL_COLOR_LIGHT_CRITICAL,
  RING_OP_LIGHT,
  LENS_STYLE,
  TIPS,
  TIP_STYLE,
  DOT_COLOR,
  PCT_COLOR,
  PROGRESS_COLOR,
  WAVE_FILL,
  WAVE_LINE,
  stateFor,
} from "./liquid-indicator-data";
import { useLiquidSpring } from "./useLiquidSpring";

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

  const { fillState, animRef } = useLiquidSpring(
    ratio,
    waveGroupRef,
    fillPathRef,
    ringRef,
    lensRef,
    isDarkRef,
  );

  const [open, setOpen] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether hover opened the popover so mouse-leave can close it
  const openedByHoverRef = useRef(false);

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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
