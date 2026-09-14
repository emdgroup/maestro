import { memo, useState, useEffect } from "react";
import { formatTimeAgoCompact } from "@/lib/format-utils";
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

export function formatElapsedCompact(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const ElapsedTime = memo(function ElapsedTime({
  status,
  stateChangedAt,
}: {
  status: SessionActivityStatus;
  stateChangedAt: number;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="text-[10px] font-mono text-muted-foreground/60 shrink-0 whitespace-nowrap">
      {status === "idle"
        ? formatTimeAgoCompact(stateChangedAt, now)
        : formatElapsedCompact(now - stateChangedAt)}
    </span>
  );
});
