import { useState } from "react";
import { GitCommitHorizontal, ChevronDown, Circle } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { cn } from "@/lib/ui-utils";
import { Button } from "@/ui/button";
import type { CommitInfo } from "@/types/bindings";

export type DiffScope = { type: "all" } | { type: "uncommitted" } | { type: "commit"; sha: string };

interface ScopeSelectorProps {
  selectedScope: DiffScope;
  onScopeChange: (scope: DiffScope) => void;
  commits: CommitInfo[];
  uncommittedFileCount: number;
  totalFileCount: number;
  isLoading?: boolean;
}

export function ScopeSelector({
  selectedScope,
  onScopeChange,
  commits,
  uncommittedFileCount,
  totalFileCount,
  isLoading,
}: ScopeSelectorProps) {
  const [open, setOpen] = useState(false);

  function getLabel(): string {
    switch (selectedScope.type) {
      case "all":
        return `All changes · ${totalFileCount} files · ${commits.length} commits`;
      case "uncommitted":
        return `Uncommitted · ${uncommittedFileCount} files`;
      case "commit": {
        const commit = commits.find((c) => c.sha === selectedScope.sha);
        return commit
          ? `${commit.sha.slice(0, 7)} — ${commit.message}`
          : selectedScope.sha.slice(0, 7);
      }
    }
  }

  function getScopeDotColor(): string {
    switch (selectedScope.type) {
      case "all":
        return "text-blue-400";
      case "uncommitted":
        return "text-amber-400";
      case "commit":
        return "text-purple-400";
    }
  }

  function handleSelect(scope: DiffScope) {
    onScopeChange(scope);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "flex items-center gap-2 w-full px-3 py-2 text-xs rounded-md",
          "bg-muted/50 hover:bg-muted border border-border/50",
          "cursor-pointer select-none transition-colors",
        )}
      >
        <Circle className={cn("size-2 fill-current", getScopeDotColor())} />
        <span className="truncate flex-1 text-left">{isLoading ? "Loading..." : getLabel()}</span>
        <ChevronDown className="size-3 text-muted-foreground shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        <Button
          variant="ghost"
          className={cn(
            "flex items-center gap-2 w-full px-3 py-2 h-auto text-xs rounded-sm hover:bg-accent justify-start",
            selectedScope.type === "all" && "bg-accent",
          )}
          onClick={() => handleSelect({ type: "all" })}
        >
          <Circle className="size-2 fill-current text-blue-400" />
          <span className="flex-1 text-left">All changes</span>
          <span className="text-muted-foreground">
            {totalFileCount} files &middot; {commits.length} commits
          </span>
        </Button>
        <Button
          variant="ghost"
          className={cn(
            "flex items-center gap-2 w-full px-3 py-2 h-auto text-xs rounded-sm hover:bg-accent justify-start",
            selectedScope.type === "uncommitted" && "bg-accent",
          )}
          onClick={() => handleSelect({ type: "uncommitted" })}
        >
          <Circle className="size-2 fill-current text-amber-400" />
          <span className="flex-1 text-left">Uncommitted</span>
          <span className="text-muted-foreground">{uncommittedFileCount} files</span>
        </Button>
        {commits.length > 0 && (
          <>
            <div className="h-px bg-border my-1" />
            <div className="max-h-48 overflow-y-auto custom-scrollbar">
              {commits.map((commit) => (
                <Button
                  key={commit.sha}
                  variant="ghost"
                  className={cn(
                    "flex items-center gap-2 w-full px-3 py-2 h-auto text-xs rounded-sm hover:bg-accent justify-start",
                    selectedScope.type === "commit" &&
                      selectedScope.sha === commit.sha &&
                      "bg-accent",
                  )}
                  onClick={() => handleSelect({ type: "commit", sha: commit.sha })}
                >
                  <GitCommitHorizontal className="size-3 text-purple-400 shrink-0" />
                  <span className="font-mono text-muted-foreground shrink-0">
                    {commit.sha.slice(0, 7)}
                  </span>
                  <span className="truncate flex-1 text-left">{commit.message}</span>
                  <span className="text-muted-foreground shrink-0">{commit.file_count}f</span>
                </Button>
              ))}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
