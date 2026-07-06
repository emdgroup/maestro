import { useState } from "react";
import { GitBranch, Check, Search, RefreshCw, ChevronDown } from "lucide-react";
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
}

function BranchList({
  branches,
  selected,
  onSelect,
}: {
  branches: string[];
  selected: string;
  onSelect: (b: string) => void;
}) {
  if (branches.length === 0) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">No branches found.</p>;
  }
  return (
    <div className="max-h-48 overflow-y-auto py-1 custom-scrollbar">
      {branches.map((b) => (
        <button
          key={b}
          type="button"
          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted transition-colors text-left"
          onClick={() => onSelect(b)}
        >
          <GitBranch className="size-3 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate">{b}</span>
          {selected === b && <Check className="size-3 shrink-0" />}
        </button>
      ))}
    </div>
  );
}

export function BranchPicker({ value, onChange, error }: BranchPickerProps) {
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
    <div className="flex items-center gap-1.5">
      <Popover
        onOpenChange={(open) => {
          if (!open) setSearch("");
        }}
      >
        <PopoverTrigger
          className={cn(
            "flex flex-1 items-center gap-2 rounded-md border bg-transparent px-3 h-9 text-sm hover:bg-muted transition-colors",
            error ? "border-destructive" : "border-border",
          )}
        >
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-left truncate">{value || "Select branch..."}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent className="w-(--anchor-width) p-0 gap-0" align="start">
          <div className="p-2 border-b border-border">
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
          <div className="p-1">
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
            onSelect={(b) => {
              onChange(b);
              setSearch("");
            }}
          />
        </PopoverContent>
      </Popover>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
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
