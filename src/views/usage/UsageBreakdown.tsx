import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { UsageTokenSplit } from "@/types/bindings";
import { formatTokens } from "./format";

export interface BreakdownRow {
  id: string;
  name: string;
  /** The project's connection, or the model's agent. */
  qualifier: string;
  value: number;
  /** A model's colour from the Model split; projects use the first series colour. */
  color?: string;
  byType: UsageTokenSplit;
}

const TYPES: [keyof UsageTokenSplit, string][] = [
  ["input", "Input"],
  ["output", "Output"],
  ["thought", "Thought"],
  ["cached_write", "Cache write"],
  ["cached_read", "Cache read"],
];

interface UsageBreakdownProps {
  rows: BreakdownRow[];
  format: (value: number) => string;
  onPick: (row: BreakdownRow) => void;
}

/** Ranked rows with a bar and a share; the chevron opens tokens by type, a click filters. */
export function UsageBreakdown({ rows, format, onPick }: UsageBreakdownProps) {
  const [open, setOpen] = useState<string[]>([]);
  const total = rows.reduce((sum, row) => sum + row.value, 0) || 1;
  const top = rows[0]?.value || 1;
  if (!rows.length) return <div className="py-2 text-xs text-muted-foreground">Nothing yet.</div>;
  return (
    <div>
      {rows.map((row) => {
        const expanded = open.includes(row.id);
        return (
          <div key={row.id}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => onPick(row)}
              onKeyDown={(event) => event.key === "Enter" && onPick(row)}
              className="cursor-pointer rounded-lg px-1.5 pt-1.5 pb-2 hover:bg-foreground/5"
            >
              <div className="flex items-center gap-2 text-[13px]">
                {row.color && (
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: row.color }}
                  />
                )}
                <span className="truncate font-medium">{row.name}</span>
                <span className="truncate text-xs text-muted-foreground">{row.qualifier}</span>
                <span className="ml-auto font-semibold tabular-nums">{format(row.value)}</span>
                <span className="w-11 text-right text-xs text-muted-foreground tabular-nums">
                  {((row.value / total) * 100).toFixed(1)}%
                </span>
                <button
                  type="button"
                  aria-label={expanded ? "Hide tokens by type" : "Tokens by type"}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpen((ids) =>
                      expanded ? ids.filter((id) => id !== row.id) : [...ids, row.id],
                    );
                  }}
                  className="text-muted-foreground hover:text-foreground [&>svg]:size-3.5"
                >
                  {expanded ? <ChevronUp /> : <ChevronDown />}
                </button>
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-foreground/10">
                <div
                  className="h-1.5 rounded-full"
                  style={{
                    width: `${(row.value / top) * 100}%`,
                    background: row.color ?? "var(--usage-1)",
                  }}
                />
              </div>
            </div>
            {expanded &&
              TYPES.map(([key, label]) => (
                <div
                  key={key}
                  className="flex py-0.5 pr-[4.25rem] pl-8 text-xs text-muted-foreground"
                >
                  <span>{label}</span>
                  <span className="ml-auto tabular-nums">{formatTokens(row.byType[key])}</span>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}
