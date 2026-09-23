import { useState } from "react";
import { History, PanelRightClose, Settings2 } from "lucide-react";
import { Button, buttonVariants } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Input } from "@/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { cn } from "@/lib/utils";
import { RunCard } from "./RunCard";
import { byDay, type RunEntry } from "./runs";
import type { RunRetention } from "@/types/bindings";

export type RunFilter = "all" | "awaiting" | "failed";

const FILTERS: Array<{ id: RunFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "awaiting", label: "Needs input" },
  { id: "failed", label: "Failed" },
];

/** A limit the user can switch off, and the number it holds while it is on. */
function LimitField({
  id,
  before,
  after,
  value,
  onChange,
}: {
  id: string;
  before: string;
  after: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  // Remembered while the limit is off, so switching it back on restores what was there.
  const [last, setLast] = useState(value ?? 1);
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-xs">
      <Checkbox
        checked={value !== null}
        onCheckedChange={(checked) => onChange(checked === true ? last : null)}
      />
      {before}
      <Input
        id={id}
        type="number"
        min={1}
        value={value ?? last}
        disabled={value === null}
        onChange={(event) => {
          const next = Math.max(1, Math.floor(Number(event.target.value) || 1));
          setLast(next);
          onChange(next);
        }}
        className="h-6 w-16 px-1.5 text-xs"
      />
      {after}
    </label>
  );
}

/**
 * How much run history this project keeps. Edited as a draft and saved as one, because every save
 * trims straight away and a half-typed number should not delete anything.
 */
function RetentionPopover({
  retention,
  onSave,
}: {
  retention: RunRetention;
  onSave: (retention: RunRetention) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(retention);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(retention);
        setOpen(next);
      }}
    >
      <PopoverTrigger
        aria-label="Run history settings"
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon" }),
          "size-6 text-muted-foreground",
        )}
      >
        <Settings2 className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-3">
        <div className="text-sm font-medium">Run history</div>
        <div className="space-y-2">
          <LimitField
            id="retention-keep-last"
            before="Keep the last"
            after="runs of each automation"
            value={draft.keep_last}
            onChange={(keep_last) => setDraft({ ...draft, keep_last })}
          />
          <LimitField
            id="retention-max-age"
            before="Keep anything newer than"
            after="days"
            value={draft.max_age_days}
            onChange={(max_age_days) => setDraft({ ...draft, max_age_days })}
          />
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {draft.keep_last === null && draft.max_age_days === null
            ? "Every run is kept."
            : "A run is deleted once it is outside every limit that is on. Its worktree and branch go with it, even with uncommitted work in them. A run still going is never deleted."}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onSave(draft);
              setOpen(false);
            }}
          >
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

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
  onDelete,
  retention,
  onRetentionChange,
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
  onDelete: (entry: RunEntry) => void;
  /** This project's, or `undefined` until the list has answered. */
  retention: RunRetention | undefined;
  onRetentionChange: (retention: RunRetention) => void;
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
        <span className="ml-auto" />
        {retention && <RetentionPopover retention={retention} onSave={onRetentionChange} />}
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Hide recent runs"
          className="size-6 text-muted-foreground"
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
                  onDelete={() => onDelete(entry)}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
