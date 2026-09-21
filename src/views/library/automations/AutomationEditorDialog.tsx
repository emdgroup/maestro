import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button, buttonVariants } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible";
import { cn } from "@/lib/utils";
import { AgentConfigFields } from "@/components/common/agent-config/AgentConfigFields";
import { WorkspaceModeSelect } from "@/components/common/workspace-mode/WorkspaceModeSelect";
import { BranchPicker } from "@/components/kanban/shared/BranchPicker";
import { useProjectSettings } from "@/services/project.service";
import { useDefaultBaseBranch } from "@/hooks/useDefaultBaseBranch";
import { useIsGitRepo } from "@/store/projectStore";
import type {
  Automation,
  AutomationSchedule,
  ConnectionKey,
  ScheduleKind,
  WorktreeWithStatus,
} from "@/types/bindings";

/** An id the user never sees or types, stable across renames. */
function newAutomationId(): string {
  return `automation-${Date.now().toString(36)}`;
}

function blank(
  workspaceMode: Automation["workspace_mode"],
  baseBranch: string,
  agentId: string,
): Automation {
  return {
    id: newAutomationId(),
    name: "",
    prompt: "",
    agent_id: agentId,
    model: null,
    permission_mode: null,
    effort: null,
    schedule: null,
    enabled: true,
    workspace_mode: workspaceMode,
    workspace_worktree_id: null,
    base_branch: baseBranch || null,
  };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Presets plus "Manual only", which is the absence of a schedule rather than a kind of one. */
function ScheduleFields({
  schedule,
  onChange,
}: {
  schedule: AutomationSchedule | null;
  onChange: (schedule: AutomationSchedule | null) => void;
}) {
  const kind = schedule?.kind ?? "Manual";

  return (
    <div className="space-y-2">
      <span className="text-[11px] text-muted-foreground">Trigger</span>
      <div className="flex gap-2">
        <Select
          value={kind}
          onValueChange={(value) =>
            onChange(
              value === "Manual"
                ? null
                : {
                    kind: value as ScheduleKind,
                    time: schedule?.time ?? "09:00",
                    weekday: value === "Weekly" ? (schedule?.weekday ?? 1) : null,
                  },
            )
          }
        >
          <SelectTrigger size="sm" className="flex-1 text-xs" aria-label="Trigger">
            <span className="flex-1 truncate text-left">
              {kind === "Manual"
                ? "Manual only"
                : kind === "Daily"
                  ? "Every day"
                  : kind === "Weekdays"
                    ? "Every weekday"
                    : "Every week"}
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="Manual" className="text-xs">
              Manual only
            </SelectItem>
            <SelectItem value="Daily" className="text-xs">
              Every day
            </SelectItem>
            <SelectItem value="Weekdays" className="text-xs">
              Every weekday
            </SelectItem>
            <SelectItem value="Weekly" className="text-xs">
              Every week
            </SelectItem>
          </SelectContent>
        </Select>

        {schedule?.kind === "Weekly" && (
          <Select
            value={String(schedule.weekday ?? 1)}
            onValueChange={(value) => onChange({ ...schedule, weekday: Number(value) })}
          >
            <SelectTrigger size="sm" className="w-32 text-xs" aria-label="Day">
              <span className="flex-1 truncate text-left">{WEEKDAYS[schedule.weekday ?? 1]}</span>
            </SelectTrigger>
            <SelectContent>
              {WEEKDAYS.map((day, index) => (
                <SelectItem key={day} value={String(index)} className="text-xs">
                  {day}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {schedule && (
          <Input
            type="time"
            value={schedule.time}
            onChange={(e) => onChange({ ...schedule, time: e.target.value })}
            aria-label="Time"
            className="h-8 w-28 text-xs"
          />
        )}
      </div>
      {schedule && (
        <p className="text-[11px] text-muted-foreground/70">
          Local time, and only while Maestro is open on this project. A time that passes while it is
          closed is skipped, not caught up.
        </p>
      )}
    </div>
  );
}

/**
 * One automation's fields.
 *
 * The agent settings are the automation's own rather than a reference to an agent profile: a
 * profile answers "what does *this role* mean on this project", and an automation has no role.
 * The fields themselves are the shared ones, so what they offer is what the agent really offers.
 *
 * Name and prompt are the whole of what an automation *is*, so they are the whole of what is on
 * screen by default. Agent and workspace both have a working default — the project's — and are
 * folded away behind one disclosure that says what those defaults currently are.
 */
export function AutomationEditorDialog({
  open,
  onOpenChange,
  projectId,
  projectPath,
  connection,
  agents,
  worktrees,
  editing,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: number;
  projectPath: string;
  connection: ConnectionKey;
  agents: Array<{ id: string; name: string }>;
  worktrees: WorktreeWithStatus[];
  /** The automation being edited, or null to create one. */
  editing: Automation | null;
  onSave: (automation: Automation) => void;
}) {
  const isGitRepo = useIsGitRepo();
  const { data: projectSettings } = useProjectSettings(projectId);
  const defaultBaseBranch = useDefaultBaseBranch(open ? projectId : null);
  // A non-git project has no worktree to offer and no branch to base one on.
  const defaultMode = isGitRepo
    ? (projectSettings?.default_workspace_mode ?? "NewWorktree")
    : "RepositoryDirectory";
  const defaultAgent = projectSettings?.default_agent ?? "";

  const [draft, setDraft] = useState<Automation>(() => editing ?? blank(defaultMode, "", ""));
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Reopening shows what is stored rather than what was abandoned last time. Adjusted during
  // render rather than from an effect, which would paint one frame of the previous edit.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      const next = editing ?? blank(defaultMode, defaultBaseBranch, defaultAgent);
      setDraft(next);
      // Open for a project with no default agent: there is nothing to run this with, and the
      // disabled Create button would be the only clue about where to fix that.
      setAdvancedOpen(next.agent_id.trim().length === 0);
    }
  }

  // The branch query may not have answered when the dialog opened, which would otherwise leave a
  // new automation with no base branch at all. Only fills a field nobody has touched.
  if (open && !editing && !draft.base_branch && defaultBaseBranch) {
    setDraft((prev) => ({ ...prev, base_branch: defaultBaseBranch }));
  }

  // Same for the agent, whose query may also land after the dialog opened. Filling it late means
  // the disclosure opened for a missing agent that now has one, so it folds away again.
  if (open && !editing && !draft.agent_id && defaultAgent) {
    setDraft((prev) => ({ ...prev, agent_id: defaultAgent }));
    setAdvancedOpen(false);
  }

  const reusable = worktrees.filter((w) => w.path !== projectPath && w.id != null);
  const patch = (fields: Partial<Automation>) => setDraft((prev) => ({ ...prev, ...fields }));

  // What the disclosure hides, said on its own row: collapsed is only safe while the user can see
  // what they are collapsing over.
  const summary = [
    agents.find((a) => a.id === draft.agent_id)?.name || draft.agent_id || "no agent",
    draft.model,
    draft.permission_mode,
    isGitRepo && draft.workspace_mode === "NewWorktree"
      ? `new worktree from ${draft.base_branch || "the default branch"}`
      : isGitRepo && draft.workspace_mode === "ReuseWorkspace"
        ? (reusable.find((w) => w.id === draft.workspace_worktree_id)?.branch_name ??
          "no workspace")
        : "repository directory",
  ]
    .filter(Boolean)
    .join(" · ");

  const nameMissing = draft.name.trim().length === 0;
  const promptMissing = draft.prompt.trim().length === 0;
  const agentMissing = draft.agent_id.trim().length === 0;
  const workspaceMissing =
    draft.workspace_mode === "ReuseWorkspace" && draft.workspace_worktree_id == null;
  const canSave = !nameMissing && !promptMissing && !agentMissing && !workspaceMissing;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit automation" : "New automation"}</DialogTitle>
          <DialogDescription>
            Give it a name, write in the prompt what it should do, and define which agent should do
            it and where it should run.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Name</span>
            <Input
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="A recognizable name for this automation"
              className="h-8 text-xs"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Prompt</span>
            <Textarea
              value={draft.prompt}
              onChange={(e) => patch({ prompt: e.target.value })}
              placeholder="What the agent should do, and what it should leave behind."
              className="min-h-28 text-xs"
            />
          </label>

          <ScheduleFields
            schedule={draft.schedule ?? null}
            onChange={(schedule) => patch({ schedule })}
          />

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[11px] text-muted-foreground hover:text-foreground">
              <ChevronDown
                className={cn("size-3.5 transition-transform", !advancedOpen && "-rotate-90")}
              />
              <span className="font-medium">Agent and workspace</span>
            </CollapsibleTrigger>

            {/* Only while collapsed: expanded, the controls themselves say this, and a summary
                that repeats them reads as a second, stale copy. */}
            {!advancedOpen && (
              <p className="truncate px-1 pl-6 text-[11px] text-muted-foreground/70">{summary}</p>
            )}

            {/* Kept mounted: `AgentConfigFields` probes the agent and resets any model, mode or
                effort it does not offer, and remounting it on every toggle re-runs that. */}
            <CollapsibleContent keepMounted className="space-y-4 px-1 pt-3">
              <AgentConfigFields
                value={draft}
                label={draft.name || "this automation"}
                agents={agents}
                projectId={projectId}
                projectPath={projectPath}
                connection={connection}
                // An automation is not a pipeline role, so nothing holds it read-only: what it may
                // do is the mode the user picks here.
                readOnly={false}
                onChange={patch}
              />

              {isGitRepo && (
                <div className="space-y-2">
                  <span className="text-[11px] text-muted-foreground">Workspace</span>
                  <WorkspaceModeSelect
                    value={draft.workspace_mode}
                    onChange={(mode) =>
                      // Writing the mode clears the pin, so switching away cannot leave a worktree
                      // id behind that nothing will look at again.
                      patch({ workspace_mode: mode, workspace_worktree_id: null })
                    }
                    hasReusableWorkspace={reusable.length > 0}
                  />

                  {draft.workspace_mode === "NewWorktree" && (
                    <BranchPicker
                      value={draft.base_branch ?? ""}
                      onChange={(branch) => patch({ base_branch: branch })}
                      prefix="From"
                    />
                  )}

                  {draft.workspace_mode === "ReuseWorkspace" && (
                    <Select
                      value={draft.workspace_worktree_id?.toString() ?? ""}
                      onValueChange={(v) => patch({ workspace_worktree_id: v ? Number(v) : null })}
                    >
                      <SelectTrigger size="sm" className="w-full text-xs" aria-label="Workspace">
                        <span className="truncate flex-1 text-left">
                          {reusable.find((w) => w.id === draft.workspace_worktree_id)
                            ?.branch_name ?? "Select a workspace"}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        {reusable.map((worktree) => (
                          <SelectItem
                            key={worktree.id}
                            value={worktree.id!.toString()}
                            className="text-xs"
                          >
                            {worktree.branch_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className={buttonVariants({ variant: "accent" })}
            disabled={!canSave}
            onClick={() => {
              onSave({
                ...draft,
                name: draft.name.trim(),
                prompt: draft.prompt.trim(),
                // Only the mode that creates a worktree branches from anything.
                base_branch:
                  draft.workspace_mode === "NewWorktree" ? (draft.base_branch ?? null) : null,
              });
              onOpenChange(false);
            }}
          >
            {editing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
