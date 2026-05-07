import { useState, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import type { PlanEntry } from "./types";
import { formatElapsed } from "@/lib/format-utils";

interface ActivityPlanPanelProps {
  entries: PlanEntry[];
}

const PRIORITY_LABEL: Record<PlanEntry["priority"], string> = {
  high: "HIGH",
  medium: "MED",
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

export function ActivityPlanPanel({ entries }: ActivityPlanPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const total = entries.length;
  const completedCount = entries.filter((e) => e.status === "completed").length;
  const inProgressEntry = entries.find((e) => e.status === "in_progress") ?? null;
  const inProgressKey = inProgressEntry?.content ?? null;

  useEffect(() => {
    setElapsedSeconds(0);
  }, [inProgressKey]);

  useEffect(() => {
    if (!inProgressKey) return;
    const id = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [inProgressKey]);

  if (total === 0 || completedCount === total) return null;

  if (expanded) {
    return (
      <div className="px-3.5 pt-2.5 pb-2">
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="w-full flex items-center gap-2 px-2 py-1 rounded-md hover:bg-muted/40 transition-colors text-left mb-2"
        >
          <span className="flex-1 text-[11px] text-muted-foreground">Plan</span>
          <ChevronDown className="w-3 h-3 text-muted-foreground rotate-180 flex-shrink-0" />
        </button>

        <div className="max-h-[280px] overflow-y-auto">
          {entries.map((entry, i) => {
            const isLast = i === entries.length - 1;
            const nextStatus = !isLast ? entries[i + 1].status : null;

            return (
              <div key={i} className="flex items-stretch min-h-[26px]">
                <div className="flex flex-col items-center w-[18px] flex-shrink-0 pt-[3px]">
                  <div
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      entry.status === "completed"
                        ? "bg-success opacity-70"
                        : entry.status === "in_progress"
                          ? "bg-accent animate-pulse"
                          : "border border-muted-foreground/40"
                    }`}
                  />
                  {!isLast && (
                    <div
                      className={`flex-1 w-0.5 rounded-sm my-0.5 ${
                        nextStatus === "completed"
                          ? "bg-success/30"
                          : nextStatus === "in_progress"
                            ? "bg-accent/30"
                            : "bg-muted/50"
                      }`}
                    />
                  )}
                </div>

                <div className="flex-1 pb-1.5 pl-2 pt-0.5 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`text-[11px] leading-snug truncate flex-1 min-w-0 ${
                        entry.status === "completed"
                          ? "text-muted-foreground/55"
                          : entry.status === "in_progress"
                            ? "text-foreground font-semibold"
                            : "text-muted-foreground"
                      }`}
                    >
                      {entry.content}
                    </span>
                    <PriorityBadge priority={entry.priority} />
                  </div>
                  {entry.status === "in_progress" && (
                    <div className="text-[9px] tabular-nums text-muted-foreground/70 mt-0.5">
                      {formatElapsed(elapsedSeconds)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="px-3.5 pt-2.5 pb-2">
      <div className="text-[11px] text-muted-foreground mb-2">Plan</div>

      {inProgressEntry && (
        <div className="flex items-center gap-2.5 px-3 py-2 mb-2 rounded-lg bg-accent/[0.06] border border-accent/15">
          <div className="w-3.5 h-3.5 rounded-full border-2 border-accent border-t-transparent animate-spin flex-shrink-0" />
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

      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-0.5 flex-1">
          {entries.map((entry, i) => (
            <div
              key={i}
              className={`flex-1 h-[3px] rounded-sm ${
                entry.status === "completed"
                  ? "bg-success"
                  : entry.status === "in_progress"
                    ? "bg-accent animate-pulse"
                    : "bg-muted"
              }`}
            />
          ))}
        </div>
        <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />
      </button>
    </div>
  );
}
