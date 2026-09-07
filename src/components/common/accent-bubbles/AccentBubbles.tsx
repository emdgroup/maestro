import React, { useEffect, useMemo, useRef, useState } from "react";
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

/**
 * The values that may safely change when a bubble finishes a cycle. Duration and delay are
 * excluded: they define the cycle itself, so changing them mid-flight would jump it. Sway is
 * excluded because it is the wrapper's width, which the keyframes translate by percentages of.
 *
 * `cycle` 0 reproduces the value the field was built with, so the first pass is unchanged.
 */
function laneCycle(
  spec: FieldSpec,
  lanes: number,
  lane: number,
  seed: number,
  cycle: number,
): Record<string, string> {
  const rand = (salt: number) => bubbleRand(seed * 7 + salt + cycle * 977);
  // Drift up to two lanes either side of home. Confined to its own 100px lane the re-roll was too
  // small to read as a change at all; letting bubbles roam the full width instead would clump them
  // and lose the even spread the lane system exists to provide.
  const drift = cycle === 0 ? 0 : Math.round((rand(7) - 0.5) * 4);
  const column = Math.min(Math.max(lane + drift, 0), Math.max(lanes - 1, 0));
  return {
    "--bx": `${column * 100 + 8 + Math.round(rand(6) * 84)}px`,
    "--bs": `${spec.minSize + Math.round(rand(1) * spec.sizeRange)}px`,
    "--bo": (0.3 + rand(4) * 0.25).toFixed(2),
    // Magnitude only — the sign lives on the class. Safe to change here because at the iteration
    // boundary the transform is translate(0, 0), so a new wrapper width moves nothing.
    "--bw": `${(spec.minSway + rand(5) * spec.swayRange).toFixed(1)}px`,
  };
}

/**
 * Giants repeat far more visibly than the small bubbles — there are only three, and they are large,
 * so a giant returning to its own column at its own size is the thing that reads as a loop. Each
 * therefore gets the whole width and a wide size range, and its start offset follows its new size,
 * or a bigger disc would begin partly on screen instead of hidden below the edge.
 */
function giantCycle(
  style: React.CSSProperties,
  index: number,
  cycle: number,
): Record<string, string> {
  const base = style as Record<string, string>;
  const baseSize = parseFloat(base["--bs"]);
  // How far below the edge this giant starts, which has to be preserved across a size change.
  const margin = -parseFloat(base["--bt"]) - baseSize;
  const rand = (salt: number) => bubbleRand((index + 1) * 7919 + salt + cycle * 977);
  // Giants get the full width and a wide size range, because they are what reads as a loop and
  // there are only three of them. Two of them overlapping is not worth defending against: at 6-12%
  // opacity they are ghosts, and a band narrow enough to guarantee separation was narrow enough
  // that the giant appeared to return to the same place.
  const size = Math.round(baseSize * (0.6 + rand(1) * 0.9));
  return {
    "--bx": `${(4 + rand(2) * 88).toFixed(1)}%`,
    "--bs": `${size}px`,
    "--bt": `${-(size + margin)}px`,
    "--bo": (parseFloat(base["--bo"]) * (0.7 + rand(3) * 0.6)).toFixed(3),
  };
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
        ...laneCycle(spec, lanes, lane, seed, 0),
        "--bu": `${duration.toFixed(2)}s`,
        "--be": `${(-rand(3) * duration).toFixed(2)}s`,
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

// The sway direction moves out of `--bw` and onto a class, because the keyframes read the sway as a
// percentage of the wrapper's width and a width cannot be negative. The spec tables above keep
// their signed values, which are what a reader wants to see; the split happens once, here.
function splitSway(style: React.CSSProperties): {
  style: React.CSSProperties;
  className: string;
} {
  const sway = parseFloat(String((style as Record<string, string>)["--bw"] ?? "4px"));
  return {
    style: { ...style, "--bw": `${Math.abs(sway)}px` } as React.CSSProperties,
    className: sway < 0 ? "accent-bubble sway-neg" : "accent-bubble",
  };
}

/** Bubbles rising in the project's accent colour. Decorative: hidden from assistive tech. */
export function AccentBubbles({ variant, className }: AccentBubblesProps) {
  const lanes = useLaneCount();
  const spec = SPECS[variant];
  const bubbles = useMemo(() => buildField(spec.bubbles, lanes), [spec, lanes]);
  const field = useMemo(() => [...bubbles, ...spec.giants], [bubbles, spec]);
  const rootRef = useRef<HTMLSpanElement>(null);

  // A CSS animation is exactly periodic, so every bubble returns to its own column at its own size
  // on every cycle. Among the small ones that reads as texture; among the three giants it reads as
  // a loop. Re-rolling on `animationiteration` breaks the repeat at the one instant the bubble is
  // fully transparent, and is nearly free: it fires once per cycle rather than per frame, and it
  // writes only static properties, so the keyframes stay free of custom properties and composited.
  //
  // One delegated listener rather than one per bubble — animation events bubble, and the disc
  // inside each wrapper is unanimated so it never fires.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const cycles = new Map<number, number>();
    const onIteration = (event: AnimationEvent) => {
      const element = event.target as HTMLElement | null;
      const attr = element?.dataset?.bubble;
      if (attr === undefined) return;
      const index = Number(attr);
      const cycle = (cycles.get(index) ?? 0) + 1;
      cycles.set(index, cycle);
      const next =
        index < bubbles.length
          ? laneCycle(spec.bubbles, lanes, Math.floor(index / spec.bubbles.perLane), index, cycle)
          : giantCycle(spec.giants[index - bubbles.length], index, cycle);
      for (const [property, value] of Object.entries(next)) {
        element?.style.setProperty(property, value);
      }
    };
    root.addEventListener("animationiteration", onIteration);
    return () => root.removeEventListener("animationiteration", onIteration);
  }, [bubbles, spec, lanes]);

  // Two elements per bubble: the wrapper carries the motion, the inner span is the visible disc.
  // See `.accent-bubble` in index.css for why the geometry is split this way.
  return (
    <span aria-hidden ref={rootRef} className={cn("accent-bubbles", className)}>
      {field.map((style, index) => {
        const bubble = splitSway(style);
        return (
          <span key={index} data-bubble={index} className={bubble.className} style={bubble.style}>
            <span className="accent-bubble-body" />
          </span>
        );
      })}
    </span>
  );
}
