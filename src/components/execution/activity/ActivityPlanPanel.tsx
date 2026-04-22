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

const PRIORITY_DOT: Record<string, string> = {
  high: "bg-destructive",
  medium: "bg-warning",
  low: "bg-muted-foreground",
};

export function ActivityPlanPanel({ entries }: ActivityPlanPanelProps) {
  const completed = entries.filter((e) => e.status === "completed").length;

  return (
    <div className="px-3 py-2 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground">Plan</span>
        <span className="text-[10px] text-muted-foreground">
          {completed}/{entries.length}
        </span>
      </div>
      <ul className="space-y-0.5">
        {entries.map((entry, i) => {
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
                className={`${
                  entry.status === "completed"
                    ? "line-through text-muted-foreground"
                    : "text-foreground"
                }`}
              >
                {entry.content}
              </span>
              <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${PRIORITY_DOT[entry.priority] ?? ""}`} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
