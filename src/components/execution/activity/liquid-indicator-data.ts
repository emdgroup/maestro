export type FillState = "critical" | "warning" | "amber" | "normal";

export const FILL_COLOR: Record<FillState, string> = {
  critical: "var(--destructive)",
  warning: "var(--warning)",
  amber: "var(--warning)",
  normal: "var(--success)",
};

// Softened critical for light theme — less violent red
export const FILL_COLOR_LIGHT_CRITICAL = "oklch(55% 0.14 25)";

export const RING_COLOR: Record<FillState, string> = {
  critical: "var(--destructive)",
  warning: "var(--warning)",
  amber: "var(--border)",
  normal: "var(--border)",
};

// Light: per-state opacity; Dark: always 0.2 (ring too prominent otherwise)
export const RING_OP_LIGHT: Record<FillState, number> = {
  critical: 0.5,
  warning: 0.5,
  amber: 1,
  normal: 1,
};

export const LENS_STYLE = {
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

export const TIPS: Record<FillState, { icon: string; text: string }> = {
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

export const TIP_STYLE: Record<FillState, string> = {
  normal: "bg-success/8 border border-success/15",
  amber: "bg-warning/8 border border-warning/15",
  warning: "bg-warning/12 border border-warning/20",
  critical: "bg-destructive/10 border border-destructive/20",
};

export const DOT_COLOR: Record<FillState, string> = {
  normal: "bg-success",
  amber: "bg-warning",
  warning: "bg-warning",
  critical: "bg-destructive shadow-[0_0_6px_var(--color-destructive)]",
};

export const PCT_COLOR: Record<FillState, string> = {
  normal: "text-success",
  amber: "text-warning",
  warning: "text-warning",
  critical: "text-destructive",
};

export const PROGRESS_COLOR: Record<FillState, string> = {
  normal: "bg-success",
  amber: "bg-warning",
  warning: "bg-warning",
  critical: "bg-destructive",
};

export function stateFor(r: number): FillState {
  if (r >= 0.85) return "critical";
  if (r >= 0.75) return "warning";
  if (r >= 0.6) return "amber";
  return "normal";
}

// Wave path: 3 periods (x=-20 to x=40), amplitude ±1.1 SVG units.
// SMIL scrolls one period (20 units) left → seamless loop.
export const WAVE_FILL =
  "M-20 0 Q-16 -1.1 -10 0 Q-4 1.1 0 0 Q4 -1.1 10 0 Q16 1.1 20 0 Q24 -1.1 30 0 Q36 1.1 40 0 L40 20 L-20 20 Z";
export const WAVE_LINE =
  "M-20 0 Q-16 -1.1 -10 0 Q-4 1.1 0 0 Q4 -1.1 10 0 Q16 1.1 20 0 Q24 -1.1 30 0 Q36 1.1 40 0";
