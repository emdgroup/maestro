import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import type { TransferState } from "./useFileTransfer";

/// Matches the 14px lucide glyphs either side of it in the toolbar, so swapping to it never
/// reflows the row — which is what the percentage it replaces used to do as its digits changed.
const SIZE = 14;
const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function ProgressRing({ progress }: { progress: number | null }) {
  const determinate = progress !== null;
  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox="0 0 14 14"
      className={cn(!determinate && "animate-spin")}
      aria-hidden="true"
    >
      <circle
        cx="7"
        cy="7"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.25"
      />
      <circle
        cx="7"
        cy="7"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        // Indeterminate draws a fixed quarter-arc and lets the spin carry the motion.
        strokeDashoffset={determinate ? CIRCUMFERENCE * (1 - progress / 100) : CIRCUMFERENCE * 0.75}
        transform={determinate ? "rotate(-90 7 7)" : undefined}
      />
    </svg>
  );
}

/// The one glyph a transfer button ever shows. `idle` is the button's own resting icon.
export function TransferIcon({ state, idle }: { state: TransferState; idle: ReactNode }) {
  switch (state.status) {
    case "busy":
      return <ProgressRing progress={state.progress} />;
    case "done":
      return <Check className="w-3.5 h-3.5" />;
    case "error":
      return <X className="w-3.5 h-3.5" />;
    default:
      return <>{idle}</>;
  }
}
