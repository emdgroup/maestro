interface WorktreeInfo {
  id: number;
  branch: string;
  isClean: boolean;
  lastCommit?: string;
  author?: string;
  timestamp?: string;
}

interface WorktreeManagerProps {
  projectId?: number;
  worktrees?: WorktreeInfo[];
  onWorktreeClick?: (worktreeId: number) => void;
}

export function WorktreeManager({ worktrees = [], onWorktreeClick }: WorktreeManagerProps) {
  // Placeholder worktrees for demonstration
  const placeholderWorktrees: WorktreeInfo[] = [
    {
      id: 1,
      branch: "main",
      isClean: true,
      lastCommit: "2 hours ago",
      author: "user@example.com",
      timestamp: "2026-02-10 09:30",
    },
    {
      id: 2,
      branch: "feature/redesign",
      isClean: false,
      lastCommit: "30 minutes ago",
      author: "contributor@example.com",
      timestamp: "2026-02-10 11:08",
    },
  ];

  const displayWorktrees = worktrees.length > 0 ? worktrees : placeholderWorktrees;

  const handleWorktreeClick = (worktreeId: number) => {
    onWorktreeClick?.(worktreeId);
  };

  return (
    <div className="h-full bg-background p-4">
      <div className="space-y-1 mb-4">
        <h2 className="text-lg font-semibold text-foreground">Worktree Manager</h2>
        <p className="text-sm text-muted-foreground">
          {displayWorktrees.length} worktree{displayWorktrees.length !== 1 ? "s" : ""}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {displayWorktrees.map((worktree) => (
          <div
            key={worktree.id}
            onClick={() => handleWorktreeClick(worktree.id)}
            className="rounded-lg border border-border bg-card shadow-sm p-4 cursor-pointer
                       hover:shadow-md hover:border-ring transition-all duration-200"
          >
            {/* Branch name */}
            <div className="mb-3">
              <h3 className="font-semibold text-foreground text-base">{worktree.branch}</h3>
            </div>

            {/* Git status indicator */}
            <div className="mb-4 flex items-center gap-2">
              {worktree.isClean ? (
                <>
                  <span className="inline-block w-2 h-2 rounded-full bg-success"></span>
                  <span className="text-sm font-medium text-success">Clean</span>
                </>
              ) : (
                <>
                  <span className="inline-block w-2 h-2 rounded-full bg-warning"></span>
                  <span className="text-sm font-medium text-warning">Dirty</span>
                </>
              )}
            </div>

            {/* Metadata */}
            <div className="space-y-1 text-xs text-muted-foreground">
              {worktree.lastCommit && (
                <p>
                  <span className="font-medium">Last commit:</span> {worktree.lastCommit}
                </p>
              )}
              {worktree.author && (
                <p>
                  <span className="font-medium">Author:</span> {worktree.author}
                </p>
              )}
              {worktree.timestamp && (
                <p>
                  <span className="font-medium">Time:</span> {worktree.timestamp}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {displayWorktrees.length === 0 && (
        <div className="flex items-center justify-center h-64 text-muted-foreground">
          <p>No worktrees available</p>
        </div>
      )}
    </div>
  );
}
