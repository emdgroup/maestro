import { Label } from "@/ui/label";
import { GitBranch } from "lucide-react";
import { BranchPicker } from "@/components/kanban/shared/BranchPicker";
import { WorkspaceModeSelect } from "@/components/common/workspace-mode/WorkspaceModeSelect";
import type { ProjectConfigRequest, WorkspaceMode } from "@/types/bindings";
import { useProjectBranchesQuery } from "@/services/task.service";

interface GitSectionProps {
  defaultWorkspaceMode: WorkspaceMode;
  /** Null means the branch the repository is on. */
  baseBranch: string | null;
  projectId: number;
  /** Persists immediately, this section has no Save button behind it. */
  onChange: (patch: Partial<ProjectConfigRequest>) => void;
}

/**
 * Where an agent works and which branch it starts from.
 *
 * Which remote it pushes to lives on the Code hosting card below, next to what that remote
 * resolves to: the setting and its consequence were a card apart, which made it possible to see
 * `fork` selected here and `origin` reported there.
 *
 * Assumes a git project. A project that is not a git repository has none of these things, so
 * `visiblePages` drops the whole page rather than letting this render an empty card.
 */
export function GitSection({
  defaultWorkspaceMode,
  baseBranch,
  projectId,
  onChange,
}: GitSectionProps) {
  const { data: branchData } = useProjectBranchesQuery(projectId);
  const currentBranch = branchData?.[1] ?? "";

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
        <GitBranch className="w-4 h-4 text-muted-foreground" />
        Git
      </h3>

      <div className="space-y-2">
        <div className="min-w-0">
          <Label htmlFor="default-workspace" className="text-sm font-medium text-foreground">
            Default workspace
          </Label>
          <div className="text-xs text-muted-foreground">
            Where new tasks and new sessions start out.
          </div>
        </div>
        <WorkspaceModeSelect
          id="default-workspace"
          value={defaultWorkspaceMode}
          onChange={(mode) => onChange({ default_workspace_mode: mode })}
          allowReuse={false}
        />
      </div>

      <div className="space-y-2">
        <div className="min-w-0">
          <Label className="text-sm font-medium text-foreground">Default base branch</Label>
          <div className="text-xs text-muted-foreground">
            The branch a new worktree is cut from, whenever a task or a session creates one. Leave
            it on auto to start from whichever branch the repository is currently on.
          </div>
        </div>
        {/* The same picker the task modal and the session dialog use, so the default is chosen
            from the same list of branches it will later seed. */}
        <BranchPicker
          value={baseBranch ?? ""}
          onChange={(branch) => onChange({ base_branch: branch || null })}
          placeholder="Auto"
          autoOption={{ label: "Auto", hint: "the branch the repository is on" }}
        />
        {baseBranch == null && currentBranch && (
          <p className="text-xs text-muted-foreground">
            Currently <span className="font-mono">{currentBranch}</span>
          </p>
        )}
      </div>
    </div>
  );
}
