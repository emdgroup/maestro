import { useState } from "react";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import type { PlanEntry } from "./types";

interface ActivityPlanPanelProps {
  entries: PlanEntry[];
}

const STATUS_ICON: Record<string, React.ElementType> = {
  pending: Circle,
  in_progress: Loader2,
  completed: CheckCircle2,
};

const UPCOMING_VISIBLE = 4;
const CIRCLE_RADIUS = 10;
const CIRCUMFERENCE = 2 * Math.PI * CIRCLE_RADIUS;

export function ActivityPlanPanel({ entries }: ActivityPlanPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const total = entries.length;
  const completed = entries.filter((e) => e.status === "completed").length;
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);

  if (total > 0 && completed === total) return null;

  const inProgress = entries.filter((e) => e.status === "in_progress");
  const pending = entries.filter((e) => e.status === "pending");

  const visibleItems = expanded
    ? entries
    : [...inProgress, ...pending.slice(0, UPCOMING_VISIBLE)];

  const hiddenCount = total - visibleItems.length;
  const offset = CIRCUMFERENCE * (1 - pct / 100);

  return (
    <div className="px-3 py-2 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground">Plan</span>
        <svg width="28" height="28" viewBox="0 0 28 28" aria-label={`${pct}% complete`}>
          <circle
            cx="14" cy="14" r={CIRCLE_RADIUS}
            fill="none" stroke="currentColor"
            className="text-muted/40" strokeWidth="2.5"
          />
          <circle
            cx="14" cy="14" r={CIRCLE_RADIUS}
            fill="none" stroke="currentColor"
            className="text-accent"
            strokeWidth="2.5"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform="rotate(-90 14 14)"
          />
          <text
            x="14" y="14"
            textAnchor="middle" dominantBaseline="central"
            className="fill-foreground"
            style={{ fontSize: "6px", fontWeight: 600 }}
          >
            {pct}%
          </text>
        </svg>
      </div>

      <ul className="space-y-0.5">
        {visibleItems.map((entry, i) => {
          const Icon = STATUS_ICON[entry.status] ?? Circle;
          return (
            <li key={i} className="flex items-center gap-1.5 text-xs">
              <Icon
                className={`w-3.5 h-3.5 shrink-0 ${
                  entry.status === "completed"
                    ? "text-success"
                    : entry.status === "in_progress"
                      ? "text-warning animate-spin"
                      : "text-muted-foreground"
                }`}
              />
              <span
                className={
                  entry.status === "completed"
                    ? "line-through text-muted-foreground"
                    : "text-foreground"
                }
              >
                {entry.content}
              </span>
            </li>
          );
        })}
      </ul>

      {!expanded && hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-[11px] text-accent hover:text-accent/80 transition-colors"
        >
          Show {hiddenCount} more
        </button>
      )}
      {expanded && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Show less
        </button>
      )}
    </div>
  );
}
