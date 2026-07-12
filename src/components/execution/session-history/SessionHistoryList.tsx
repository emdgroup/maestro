import { format } from "date-fns";
import { Check, Pencil, RefreshCw, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { ScrollArea } from "@/ui/scroll-area";
import { Checkbox } from "@/ui/checkbox";

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return format(date, "MMM d");
}

interface Entry {
  session_id: string;
  title: string | null;
  updated_at: string | null;
}

interface Props {
  entries: Entry[];
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  onRefetch: () => void;
  query: string;
  onQueryChange: (q: string) => void;
  summaryLabel: string;
  ticked: Set<string>;
  onToggleTick: (id: string) => void;
  onSetTicked: (s: Set<string>) => void;
  onRowClick: (id: string, title: string | null) => void;
  onOpenTicked: () => void;
  loadMutationPending: boolean;
  agentName: string;
  renamingId: string | null;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  onRenameValueChange: (v: string) => void;
  onStartRename: (id: string, title: string | null, e: React.MouseEvent) => void;
  onCommitRename: (id: string) => void;
  onCancelRename: () => void;
  allSelected: boolean;
  someSelected: boolean;
  onSelectAll: () => void;
  supportsSessionDelete: boolean;
  deleteMutationPending: boolean;
  onDeleteTicked: () => void;
}

export function SessionHistoryList({
  entries,
  isLoading,
  isError,
  isFetching,
  onRefetch,
  query,
  onQueryChange,
  summaryLabel,
  ticked,
  onToggleTick,
  onSetTicked,
  onRowClick,
  onOpenTicked,
  loadMutationPending,
  agentName,
  renamingId,
  renameValue,
  renameInputRef,
  onRenameValueChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
  allSelected,
  someSelected,
  onSelectAll,
  supportsSessionDelete,
  deleteMutationPending,
  onDeleteTicked,
}: Props) {
  return (
    <div className="flex flex-1 flex-col min-w-0">
      {/* Search row */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={`Search ${agentName} sessions…`}
            className="w-full h-8 bg-muted/30 border border-border rounded pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-ring"
          />
        </div>
        <Button
          variant="ghost"
          onClick={onRefetch}
          disabled={isFetching}
          className="h-8 w-8 shrink-0 border border-border text-muted-foreground hover:text-foreground"
          title="Refresh"
        >
          <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
        </Button>
      </div>

      {/* Summary bar */}
      <div className="px-3 py-1.5 border-b border-border shrink-0 flex items-center gap-2">
        <span onClick={(e) => e.stopPropagation()} className="shrink-0">
          <Checkbox
            className="border-border"
            checked={allSelected}
            indeterminate={someSelected}
            onCheckedChange={onSelectAll}
          />
        </span>
        <span className="text-[10px] text-muted-foreground/60">{summaryLabel}</span>
      </div>

      {/* Session list */}
      <ScrollArea className="flex-1 min-h-0">
        {isLoading && (
          <div className="text-xs text-muted-foreground py-8 text-center">Loading…</div>
        )}
        {isError && (
          <div className="text-xs text-destructive py-8 text-center">Failed to load history</div>
        )}
        {!isLoading && !isError && entries.length === 0 && (
          <div className="text-xs text-muted-foreground py-8 text-center">
            {query ? "No results" : "No sessions"}
          </div>
        )}
        <div className="py-1">
          {entries.map((entry) => (
            <div key={entry.session_id} className="px-2">
              {renamingId === entry.session_id ? (
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-md">
                  <input
                    ref={renameInputRef}
                    className="flex-1 text-xs bg-transparent border-b border-ring outline-none"
                    value={renameValue}
                    onChange={(e) => onRenameValueChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onCommitRename(entry.session_id);
                      if (e.key === "Escape") onCancelRename();
                    }}
                    onBlur={() => onCommitRename(entry.session_id)}
                    autoFocus
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0 shrink-0"
                    onClick={() => onCommitRename(entry.session_id)}
                  >
                    <Check className="size-2.5" />
                  </Button>
                </div>
              ) : (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onRowClick(entry.session_id, entry.title)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ")
                      onRowClick(entry.session_id, entry.title);
                  }}
                  className={cn(
                    "group flex items-center gap-2.5 w-full px-2 py-2 rounded-md cursor-pointer transition-colors",
                    ticked.has(entry.session_id) ? "bg-muted/40" : "hover:bg-muted/20",
                  )}
                >
                  <span onClick={(e) => e.stopPropagation()} className="shrink-0">
                    <Checkbox
                      className="border-border"
                      checked={ticked.has(entry.session_id)}
                      onCheckedChange={() => onToggleTick(entry.session_id)}
                    />
                  </span>
                  <span className="flex-1 min-w-0 text-xs font-medium text-foreground truncate">
                    {entry.title ?? entry.session_id}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="opacity-0 group-hover:opacity-100 p-0.5 transition-opacity hover:bg-muted/40"
                    onClick={(e) => onStartRename(entry.session_id, entry.title, e)}
                    title="Rename"
                  >
                    <Pencil className="size-2.5 text-muted-foreground" />
                  </Button>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {entry.updated_at && (
                      <span className="text-[10px] text-muted-foreground/60">
                        {relativeTime(entry.updated_at)}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>

      {/* Multi-select footer */}
      <div
        className={cn(
          "overflow-hidden transition-[height,opacity] duration-200 border-t border-border shrink-0",
          ticked.size > 0 ? "h-12 opacity-100" : "h-0 opacity-0",
        )}
      >
        <div className="flex items-center justify-between px-4 h-12">
          <span className="text-xs text-muted-foreground">
            {ticked.size} session{ticked.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => onSetTicked(new Set())}
            >
              Clear
            </Button>
            <Button
              variant="accent"
              size="sm"
              className="h-7 text-xs"
              disabled={loadMutationPending}
              onClick={onOpenTicked}
            >
              Open
            </Button>
            {supportsSessionDelete && (
              <Button
                variant="destructive"
                size="sm"
                className="h-7 text-xs"
                disabled={deleteMutationPending}
                onClick={onDeleteTicked}
              >
                Delete
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
