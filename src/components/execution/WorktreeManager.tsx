import { useState, useMemo } from "react";
import { cn } from "@/lib";
import { Input } from "@/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { useNavigate } from "@/store/navigationStore";
import type { WorktreeWithStatus } from "@/types/bindings";

const STATUS_FILTERS = ["All", "Active", "Modified", "Idle"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function parseDiffStat(
  raw: string | null,
): { files: number; insertions: number; deletions: number } | null {
  if (!raw) return null;
  const filesMatch = raw.match(/(\d+) files? changed/);
  const insMatch = raw.match(/(\d+) insertions?\(\+\)/);
  const delMatch = raw.match(/(\d+) deletions?\(-\)/);
  if (!filesMatch && !insMatch && !delMatch) return null;
  return {
    files: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
    deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
  };
}

interface WorktreeManagerProps {
  worktrees: WorktreeWithStatus[];
  selectedWorktreeId: number | null;
  onSelect: (worktreeId: number | null) => void;
  repoPath: string;
}

export function WorktreeManager({
  worktrees,
  selectedWorktreeId,
  onSelect,
}: WorktreeManagerProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const navigate = useNavigate();

  const filteredWorktrees = useMemo(() => {
    return worktrees
      .filter((wt) => {
        if (statusFilter === "All") return true;
        if (statusFilter === "Active") return wt.agent_status === "running";
        if (statusFilter === "Modified") return wt.git_status !== "";
        if (statusFilter === "Idle")
          return wt.agent_status !== "running" && wt.git_status === "";
        return true;
      })
      .filter(
        (wt) =>
          search.trim() === "" ||
          wt.branch_name.toLowerCase().includes(search.toLowerCase()),
      );
  }, [worktrees, statusFilter, search]);

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-72 flex flex-col border-r border-border bg-card shrink-0">
        {/* Header */}
        <div className="px-3 py-3 border-b border-border bg-muted/30 font-semibold text-sm">
          Worktrees
        </div>

        {/* Filter toolbar */}
        <div className="h-12 border-b border-border bg-muted/30 flex items-center px-3 gap-2 shrink-0">
          <Input
            type="text"
            placeholder="Search branches..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-32 text-sm"
          />
          <ToggleGroup variant="outline" size="sm" defaultValue={["All"]}>
            {STATUS_FILTERS.map((f) => (
              <ToggleGroupItem
                key={f}
                value={f}
                pressed={statusFilter === f}
                onClick={() => setStatusFilter(f)}
                className="text-xs px-2"
              >
                {f}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        {/* Worktree list */}
        <div className="flex-1 overflow-y-auto">
          {worktrees.length === 0 && (
            <div className="text-xs text-muted-foreground py-8 text-center">
              No worktrees found
            </div>
          )}
          {worktrees.length > 0 && filteredWorktrees.length === 0 && (
            <div className="text-xs text-muted-foreground py-8 text-center">
              No worktrees match your filter
            </div>
          )}
          {filteredWorktrees.map((wt) => {
            const diffStat = parseDiffStat(wt.diff_stat);
            return (
              <div
                key={wt.path}
                onClick={() => onSelect(wt.id)}
                className={cn(
                  "px-3 py-3 cursor-pointer border-l-2 transition-colors",
                  wt.id === selectedWorktreeId
                    ? "border-ring bg-muted/20"
                    : "border-transparent hover:bg-muted/10",
                )}
              >
                {/* Line 1: status dot + branch name + badges */}
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "inline-block w-2 h-2 rounded-full shrink-0",
                      wt.git_status === "" ? "bg-success" : "bg-warning",
                    )}
                  />
                  <span className="text-sm font-medium truncate font-mono">
                    {wt.branch_name}
                  </span>
                  {wt.is_zombie && (
                    <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-warning/15 text-warning font-medium">
                      Zombie
                    </span>
                  )}
                  {wt.is_orphan && (
                    <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                      Orphan
                    </span>
                  )}
                </div>

                {/* Line 2: task name (clickable) or "No task" */}
                <div className="mt-0.5 pl-4">
                  {wt.task_name && wt.task_id ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate({ taskId: String(wt.task_id) });
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground hover:underline truncate"
                    >
                      {wt.task_name}
                    </button>
                  ) : (
                    <span className="text-xs text-muted-foreground">No task</span>
                  )}
                </div>

                {/* Line 3: diff shortstat (dirty worktrees only) */}
                {diffStat && (
                  <div className="text-xs mt-0.5 pl-4">
                    <span className="text-muted-foreground">{diffStat.files} files changed</span>
                    {diffStat.insertions > 0 && (
                      <span className="text-success ml-1">+{diffStat.insertions}</span>
                    )}
                    {diffStat.deletions > 0 && (
                      <span className="text-destructive ml-1">-{diffStat.deletions}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right panel — detail content added in Plan 03 */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          Select a worktree to view details
        </div>
      </div>
    </div>
  );
}
