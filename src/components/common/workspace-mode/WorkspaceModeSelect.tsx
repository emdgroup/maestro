import { GitBranchPlus, FolderRoot, FolderGit2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import type { WorkspaceMode } from "@/types/bindings";

/// The one place the three workspaces are described, so a task, a session and the project default
/// read the same words for the same choice.
const MODES: {
  value: WorkspaceMode;
  label: string;
  description: string;
  icon: typeof GitBranchPlus;
}[] = [
  {
    value: "NewWorktree",
    label: "Create new worktree",
    description: "Create an isolated worktree on a branch",
    icon: GitBranchPlus,
  },
  {
    value: "RepositoryDirectory",
    label: "Use the repository directory",
    description: "Work directly in the project directory (no worktree)",
    icon: FolderRoot,
  },
  {
    value: "ReuseWorkspace",
    label: "Reuse an existing workspace",
    description: "Work in a worktree that already exists",
    icon: FolderGit2,
  },
];

interface WorkspaceModeSelectProps {
  value: WorkspaceMode;
  onChange: (mode: WorkspaceMode) => void;
  /** False for terminal sessions, which attach to a checkout rather than creating one. */
  allowNewWorktree?: boolean;
  /** False in Settings: a project default cannot name a specific workspace. */
  allowReuse?: boolean;
  /** Why an unavailable option is unavailable, shown in place of its description. */
  unavailableReason?: string;
  id?: string;
}

export function WorkspaceModeSelect({
  value,
  onChange,
  allowNewWorktree = true,
  allowReuse = true,
  unavailableReason,
  id,
}: WorkspaceModeSelectProps) {
  const isAllowed = (mode: WorkspaceMode) =>
    (mode !== "NewWorktree" || allowNewWorktree) && (mode !== "ReuseWorkspace" || allowReuse);

  // Settings drops the reuse option entirely — there is nothing to explain about a choice that
  // makes no sense as a default. Everywhere else an unavailable option stays visible and disabled,
  // so "why can't I create a worktree here" has an answer on screen.
  const options = MODES.filter((mode) => mode.value !== "ReuseWorkspace" || allowReuse);
  const selected = MODES.find((mode) => mode.value === value) ?? MODES[0];
  const SelectedIcon = selected.icon;

  return (
    <Select value={value} onValueChange={(next) => onChange(next as WorkspaceMode)}>
      {/* `data-[size=default]:h-auto` rather than `h-auto`: the trigger's own height is set under
          that variant, which outranks a plain utility, so an unqualified `h-auto` leaves the
          two-line content overflowing a 36px box. */}
      <SelectTrigger
        id={id}
        className="w-full data-[size=default]:h-auto py-2 px-3 border-border bg-transparent shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
      >
        <span className="flex items-center gap-2 min-w-0 flex-1 text-left">
          <SelectedIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm truncate">{selected.label}</span>
            <span className="block text-xs text-muted-foreground truncate">
              {selected.description}
            </span>
          </span>
        </span>
      </SelectTrigger>
      <SelectContent>
        {options.map((mode) => {
          const Icon = mode.icon;
          const allowed = isAllowed(mode.value);
          return (
            <SelectItem key={mode.value} value={mode.value} disabled={!allowed} className="py-2">
              <span className="flex items-center gap-2 min-w-0">
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block text-sm">{mode.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {allowed ? mode.description : (unavailableReason ?? mode.description)}
                  </span>
                </span>
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
