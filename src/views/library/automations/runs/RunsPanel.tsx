import { History, PanelRightClose } from "lucide-react";
import { Button } from "@/ui/button";
import { cn } from "@/lib/utils";
import { RunCard } from "./RunCard";
import { byDay, type RunEntry } from "./runs";

export type RunFilter = "all" | "awaiting" | "failed";

const FILTERS: Array<{ id: RunFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "awaiting", label: "Needs input" },
  { id: "failed", label: "Failed" },
];

/**
 * Every automation's runs, newest first, grouped by day.
 *
 * The same shape as the pull request panel in Worktrees, for the same reason: this answers "what
 * happened while I was out", which is a question about a span of time rather than about one row.
 *
 * Needs input is a filter rather than a badge somewhere because it is the only state here that is
 * waiting on the person reading it.
 */
export function RunsPanel({
  entries,
  now,
  filter,
  onFilterChange,
  onOpen,
  loading,
  onClose,
}: {
  entries: RunEntry[];
  /** The page's clock, so every duration on screen moves together. */
  now: number;
  filter: RunFilter;
  onFilterChange: (filter: RunFilter) => void;
  onOpen: (entry: RunEntry) => void;
  /** The run id being loaded back into a session, if any. */
  loading: string | null;
  onClose: () => void;
}) {
  const awaiting = entries.filter((entry) => entry.state === "awaiting").length;
  const shown = entries.filter((entry) =>
    filter === "all"
      ? true
      : filter === "awaiting"
        ? entry.state === "awaiting"
        : entry.state === "failed",
  );
  const days = byDay(shown, new Date(now));

  return (
    // No border and no top edge: the column runs out from under the action bar as one surface,
    // which is what the rounded corner beside it is for. Same treatment as the pull request panel.
    <div className="flex h-full w-72 shrink-0 flex-col bg-card">
      <div className="flex items-center gap-1 px-2 py-2">
        <span className="text-[11px] font-medium">Recent runs</span>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Hide recent runs"
          className="ml-auto size-6 text-muted-foreground"
        >
          <PanelRightClose className="size-3.5" />
        </Button>
      </div>

      <div className="flex gap-1 px-2 pb-2">
        {FILTERS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => onFilterChange(id)}
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] transition-colors",
              filter === id
                ? id === "awaiting"
                  ? "bg-amber-500/20 text-amber-600"
                  : "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
            {id === "awaiting" && awaiting > 0 && ` ${awaiting}`}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-3">
        {shown.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-2 py-8 text-center">
            <History className="size-5 text-muted-foreground/40" />
            <p className="text-[11px] text-muted-foreground">
              {filter === "all"
                ? "Nothing has run yet. A run appears here whether or not Maestro was open when it happened."
                : filter === "awaiting"
                  ? "Nothing is waiting on you."
                  : "Nothing has failed."}
            </p>
          </div>
        ) : (
          days.map(([day, runs]) => (
            <div key={day} className="space-y-1.5">
              <div className="text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground/70">
                {day}
              </div>
              {runs.map((entry) => (
                <RunCard
                  key={entry.run.id}
                  entry={entry}
                  withName
                  now={now}
                  onOpen={() => onOpen(entry)}
                  pending={loading === entry.run.id}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
