import React, { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

// Integer hash → [0, 1). Bubble parameters must be deterministic per slot: Math.random would
// reshuffle the whole field on every mount and make the animation phases jump.
function bubbleRand(seed: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Lanes are 100px wide, and both fields span the window, so the count follows the window: a
// fixed count either leaves a bare strip on a wide monitor or animates lanes that are clipped
// off-screen. One spare lane covers the remainder past the last full one.
function laneCountFor(width: number): number {
  return Math.ceil(width / 100) + 1;
}

function useLaneCount(): number {
  const [lanes, setLanes] = useState(() => laneCountFor(window.innerWidth));
  useEffect(() => {
    // Only a crossing of a 100px boundary changes the field, so most resize events settle to
    // the same count and re-render nothing.
    const onResize = () => setLanes(laneCountFor(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return lanes;
}

interface FieldSpec {
  /** Bubbles per 100px lane — the density rule from the design. */
  perLane: number;
  minSize: number;
  sizeRange: number;
  minDuration: number;
  durationRange: number;
  minSway: number;
  swayRange: number;
  /** Overrides for the CSS defaults; a screen-tall field has to travel much further. */
  travel?: string;
  start?: string;
}

function buildField(spec: FieldSpec, lanes: number): React.CSSProperties[] {
  const bubbles: React.CSSProperties[] = [];
  for (let lane = 0; lane < lanes; lane++) {
    for (let slot = 0; slot < spec.perLane; slot++) {
      const seed = lane * spec.perLane + slot;
      const rand = (salt: number) => bubbleRand(seed * 7 + salt);
      const duration = spec.minDuration + rand(2) * spec.durationRange;
      const sway = (spec.minSway + rand(5) * spec.swayRange) * (seed % 2 === 0 ? 1 : -1);
      bubbles.push({
        "--bx": `${lane * 100 + 8 + Math.round(rand(6) * 84)}px`,
        "--bs": `${spec.minSize + Math.round(rand(1) * spec.sizeRange)}px`,
        "--bu": `${duration.toFixed(2)}s`,
        "--be": `${(-rand(3) * duration).toFixed(2)}s`,
        "--bo": (0.3 + rand(4) * 0.25).toFixed(2),
        "--bw": `${sway.toFixed(1)}px`,
        ...(spec.travel ? { "--bv": spec.travel } : {}),
        ...(spec.start ? { "--bt": spec.start } : {}),
      } as React.CSSProperties);
    }
  }
  return bubbles;
}

// Ghost giants looming behind the field, placed at percentages so they follow the width.
// They travel far enough to fully clear the top edge before their fade.
const HEADER_GIANTS = [
  {
    "--bx": "8%",
    "--bs": "64px",
    "--bt": "-72px",
    "--bu": "13s",
    "--be": "-2s",
    "--bo": "0.12",
    "--bv": "-140px",
    "--bw": "6px",
  },
  {
    "--bx": "45%",
    "--bs": "84px",
    "--bt": "-94px",
    "--bu": "16s",
    "--be": "-8s",
    "--bo": "0.09",
    "--bv": "-158px",
    "--bw": "-7px",
  },
  {
    "--bx": "74%",
    "--bs": "92px",
    "--bt": "-102px",
    "--bu": "18s",
    "--be": "-13s",
    "--bo": "0.07",
    "--bv": "-168px",
    "--bw": "8px",
  },
].map((style) => style as React.CSSProperties);

const SCREEN_GIANTS = [
  {
    "--bx": "8%",
    "--bs": "140px",
    "--bt": "-160px",
    "--bu": "70s",
    "--be": "-10s",
    "--bo": "0.10",
    "--bv": "-125vh",
    "--bw": "14px",
  },
  {
    "--bx": "46%",
    "--bs": "180px",
    "--bt": "-200px",
    "--bu": "88s",
    "--be": "-35s",
    "--bo": "0.08",
    "--bv": "-125vh",
    "--bw": "-18px",
  },
  {
    "--bx": "76%",
    "--bs": "210px",
    "--bt": "-230px",
    "--bu": "104s",
    "--be": "-63s",
    "--bo": "0.06",
    "--bv": "-125vh",
    "--bw": "22px",
  },
].map((style) => style as React.CSSProperties);

const SPECS = {
  header: {
    bubbles: {
      perLane: 3,
      minSize: 3,
      sizeRange: 11,
      minDuration: 5,
      durationRange: 4,
      minSway: 3,
      swayRange: 3,
    },
    giants: HEADER_GIANTS,
  },
  // More per lane than the bar, but each lane is a window tall rather than 48px, so the field
  // is far sparser per unit of area — and every bubble is a composited layer, so it stays low.
  screen: {
    bubbles: {
      perLane: 6,
      minSize: 4,
      sizeRange: 14,
      minDuration: 24,
      durationRange: 18,
      minSway: 8,
      swayRange: 12,
      travel: "-105vh",
      start: "-24px",
    },
    giants: SCREEN_GIANTS,
  },
} satisfies Record<string, { bubbles: FieldSpec; giants: React.CSSProperties[] }>;

interface AccentBubblesProps {
  /** `header` fills the 48px bar, `screen` a whole view. */
  variant: keyof typeof SPECS;
  /** Stacking is the caller's problem: a parent painting its own background needs `z-0`
      plus a raised content layer, one that does not can use `-z-10`. */
  className?: string;
}

/** Bubbles rising in the project's accent colour. Decorative: hidden from assistive tech. */
export function AccentBubbles({ variant, className }: AccentBubblesProps) {
  const lanes = useLaneCount();
  const spec = SPECS[variant];
  const bubbles = useMemo(() => buildField(spec.bubbles, lanes), [spec, lanes]);

  return (
    <span aria-hidden className={cn("accent-bubbles", className)}>
      {bubbles.map((style, index) => (
        <span key={index} className="accent-bubble" style={style} />
      ))}
      {spec.giants.map((style, index) => (
        <span key={`giant-${index}`} className="accent-bubble" style={style} />
      ))}
    </span>
  );
}
