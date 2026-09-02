import { useState } from "react";
import { GitBranch, Check, Search, RefreshCw, ChevronDown, Sparkles } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils.ts";
import { Button } from "@/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { useProjectBranchesQuery, taskQueryKeys } from "@/services/task.service";
import { useSelectedProject } from "@/store/projectStore";

interface BranchPickerProps {
  value: string;
  onChange: (branch: string) => void;
  error?: boolean;
  /** Short word rendered as a divided prefix inside the box, e.g. "From". */
  prefix?: string;
  /**
   * A control to render in the prefix slot instead of a static word — used by `NewWorktreeFields`
   * to make the label itself the create/checkout switch. It is a sibling of the popover trigger
   * rather than a child of it, because a button inside a button is invalid and its clicks would
   * open the branch list.
   */
  prefixControl?: React.ReactNode;
  /**
   * Why a branch cannot be picked, or null when it can. A branch with a reason renders disabled
   * and says so, rather than being filtered out — a user searching for a branch that exists has
   * to find it, even when it is unavailable.
   */
  unavailable?: (branch: string) => string | null;
  /** Shown when nothing is picked. Defaults to asking for a branch. */
  placeholder?: string;
  /**
   * Offers "no branch in particular" as a row above the list, selecting the empty string. Used by
   * the project's default base branch, where the absence of a choice is itself a valid answer;
   * a caller that requires a branch simply leaves this off.
   */
  autoOption?: { label: string; hint?: string };
}

function BranchList({
  branches,
  selected,
  onSelect,
  unavailable,
}: {
  branches: string[];
  selected: string;
  onSelect: (b: string) => void;
  unavailable?: (branch: string) => string | null;
}) {
  if (branches.length === 0) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">No branches found.</p>;
  }
  return (
    <div className="max-h-48 overflow-y-auto py-1 custom-scrollbar">
      {branches.map((b) => {
        const reason = unavailable?.(b) ?? null;
        return (
          <button
            key={b}
            type="button"
            disabled={reason !== null}
            title={reason ?? undefined}
            className={cn(
              "flex items-center gap-2 w-full rounded-md px-3 py-1.5 text-xs transition-colors text-left",
              reason === null
                ? "hover:bg-muted"
                : "opacity-50 cursor-not-allowed text-muted-foreground",
            )}
            onClick={() => onSelect(b)}
          >
            <GitBranch className="size-3 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">{b}</span>
            {reason !== null && (
              <span className="shrink-0 text-[10px] italic truncate max-w-[45%]">{reason}</span>
            )}
            {selected === b && <Check className="size-3 shrink-0" />}
          </button>
        );
      })}
    </div>
  );
}

export function BranchPicker({
  value,
  onChange,
  error,
  prefix,
  prefixControl,
  unavailable,
  placeholder = "Select branch...",
  autoOption,
}: BranchPickerProps) {
  const queryClient = useQueryClient();
  const project = useSelectedProject();
  const projectId = project?.id ?? null;
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"local" | "remote">("local");

  const { data: branchData, isFetching } = useProjectBranchesQuery(projectId);
  const local: string[] = branchData?.[0].local ?? [];
  const remote: string[] = branchData?.[0].remote ?? [];

  const filteredLocal = local.filter((b) => b.toLowerCase().includes(search.toLowerCase()));
  const filteredRemote = remote.filter((b) => b.toLowerCase().includes(search.toLowerCase()));

  return (
    // `min-w-0` on the row and the refresh button held out of the shrink: without it the row's
    // min-content width is the whole branch name, and a long one — `origin/release-please--…` —
    // pushed the row past the right edge of whatever dialog it was in rather than truncating.
    <div className="flex min-w-0 items-center gap-1.5">
      {/* The prefix is a sibling of the trigger, not a child: `prefixControl` is itself a button,
          and nesting it would be invalid markup whose clicks opened the branch list. Both halves
          share one bordered box, so the seam that used to be a divider is now a real edge. */}
      <div
        className={cn(
          "flex flex-1 items-stretch overflow-hidden rounded-md border bg-transparent h-9 text-sm",
          error ? "border-destructive" : "border-border",
        )}
      >
        {prefixControl ??
          (prefix && (
            <span className="flex items-center shrink-0 border-r border-border px-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {prefix}
            </span>
          ))}
        <Popover
          onOpenChange={(open) => {
            if (!open) setSearch("");
          }}
        >
          <PopoverTrigger className="flex flex-1 items-center gap-2 px-3 min-w-0 hover:bg-muted transition-colors">
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 text-left truncate">{value || placeholder}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </PopoverTrigger>
          <PopoverContent className="w-(--anchor-width) p-1 gap-0" align="start">
            <div className="pb-2 border-b border-border">
              <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-muted/50">
                <Search className="size-3.5 text-muted-foreground shrink-0" />
                <input
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  placeholder="Search branches..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
            {/* Above the tabs rather than inside a list: it is not a branch, so it belongs to
                neither tab, and it disappears while searching because a search is a search for a
                branch by name. */}
            {autoOption && !search && (
              <button
                type="button"
                onClick={() => onChange("")}
                className="mt-1 flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                <Sparkles className="size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {autoOption.label}
                  {autoOption.hint && (
                    <span className="text-muted-foreground"> ({autoOption.hint})</span>
                  )}
                </span>
                {!value && <Check className="size-3 shrink-0" />}
              </button>
            )}

            <div className="py-1">
              <div className="flex rounded-md bg-muted p-0.5 gap-0.5">
                {(["local", "remote"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={cn(
                      "flex-1 rounded-[5px] px-2 py-1 text-xs font-medium transition-colors capitalize",
                      tab === t
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground/80",
                    )}
                  >
                    {t === "local"
                      ? `Local (${filteredLocal.length})`
                      : `Remote (${filteredRemote.length})`}
                  </button>
                ))}
              </div>
            </div>
            <BranchList
              branches={tab === "local" ? filteredLocal : filteredRemote}
              selected={value}
              unavailable={unavailable}
              onSelect={(b) => {
                onChange(b);
                setSearch("");
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        onClick={() =>
          void queryClient.invalidateQueries({
            queryKey: [...taskQueryKeys.base, "branches", projectId],
          })
        }
        disabled={isFetching}
      >
        <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
      </Button>
    </div>
  );
}
