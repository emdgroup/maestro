import { useState, useEffect } from "react";
import type { PlanEntry } from "./types";
import { formatElapsed } from "@/lib/format-utils";

interface ActivityPlanPanelProps {
  entries: PlanEntry[];
  title?: string | null;
}

const PRIORITY_LABEL: Record<PlanEntry["priority"], string> = {
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
};

const PRIORITY_CLASS: Record<PlanEntry["priority"], string> = {
  high: "text-accent border-accent/30 bg-accent/[0.08]",
  medium: "text-muted-foreground/70 border-border/50",
  low: "text-muted-foreground/40 border-border/30",
};

function PriorityBadge({ priority }: { priority: PlanEntry["priority"] }) {
  return (
    <span
      className={`text-[8px] font-semibold tracking-wider border rounded px-1 py-px flex-shrink-0 ${PRIORITY_CLASS[priority]}`}
    >
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

export function ActivityPlanPanel({ entries, title }: ActivityPlanPanelProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const total = entries.length;
  const completedCount = entries.filter((e) => e.status === "completed").length;
  const inProgressEntry = entries.find((e) => e.status === "in_progress") ?? null;
  const inProgressKey = inProgressEntry?.content ?? null;

  // A new step restarts the clock. Adjusted during render rather than from the effect,
  // which owns only the ticking.
  const [timedStep, setTimedStep] = useState(inProgressKey);
  if (timedStep !== inProgressKey) {
    setTimedStep(inProgressKey);
    setElapsedSeconds(0);
  }

  useEffect(() => {
    if (!inProgressKey) return;
    const id = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [inProgressKey]);

  if (total === 0 || completedCount === total) return null;

  const planLabel = title ?? "Plan";

  return (
    <div className="w-full px-3.5 pt-2.5 pb-2">
      <div className="text-[11px] text-muted-foreground mb-2">{planLabel}</div>

      {inProgressEntry && (
        <div className="flex items-center gap-2.5 px-3 py-2 mb-2 rounded-lg bg-accent/6 border border-accent/15">
          <div className="w-3.5 h-3.5 rounded-full border-2 border-accent border-t-transparent animate-spin shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-foreground leading-snug truncate">
              {inProgressEntry.content}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {formatElapsed(elapsedSeconds)}
              </span>
              <PriorityBadge priority={inProgressEntry.priority} />
            </div>
          </div>
        </div>
      )}

      {/* Filled by position, not by which entry holds which status: the rail reads as a
          progress bar, so a plan completed out of order still fills left to right. */}
      <div className="flex items-center gap-0.5 px-2 py-1.5">
        {Array.from({ length: total }, (_, i) =>
          i === completedCount && inProgressEntry ? (
            <div key={i} className="flex-1 h-0.75 rounded-sm relative overflow-hidden bg-accent/20">
              <div className="absolute inset-y-0 left-0 w-[60%] rounded-r-sm animate-rail-comet bg-gradient-to-r from-transparent via-accent/50 to-accent" />
            </div>
          ) : (
            <div
              key={i}
              className={`flex-1 h-0.75 rounded-sm ${i < completedCount ? "bg-accent" : "bg-muted"}`}
            />
          ),
        )}
      </div>
    </div>
  );
}
