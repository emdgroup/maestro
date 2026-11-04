import type { SessionActivityStatus } from "@/store/sessionActivityStore";

export const ACTIVITY_DOT: Record<SessionActivityStatus, string> = {
  spawning: "bg-muted-foreground/60 animate-pulse",
  thinking: "bg-purple animate-glow-purple",
  acting: "bg-info animate-glow-info",
  awaiting_input: "bg-warning animate-pulse",
  idle: "bg-muted-foreground/40",
  stale: "bg-destructive animate-pulse",
};

// Colour only: `animate-glow-*` is a box-shadow, a halo on the round dot but a box around a span.
export const ACTIVITY_TEXT: Record<SessionActivityStatus, string> = {
  spawning: "text-muted-foreground/60",
  thinking: "text-purple",
  acting: "text-info",
  awaiting_input: "text-warning",
  idle: "text-muted-foreground/40",
  stale: "text-destructive",
};
