import { useState } from "react";
import { Ban, CalendarClock, ChevronDown, Webhook, type LucideIcon } from "lucide-react";
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
import { useBackgroundServerQuery } from "@/services/automation.service";
import { useDefaultBaseBranch } from "@/hooks/useDefaultBaseBranch";
import { useIsGitRepo } from "@/store/projectStore";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { CronEditor } from "./cron/CronEditor";
import { WebhookSection } from "./WebhookSection";
import { describeExpression } from "./cron/describe";
import { DEFAULT_CRON } from "./cron/templates";
import { localTimezone } from "./schedule";
import type {
  Automation,
  ConnectionKey,
  WorkspaceMode,
  WorktreeWithStatus,
} from "@/types/bindings";

/** An id the user never sees or types, stable across renames. */
function newAutomationId(): string {
  return `automation-${Date.now().toString(36)}`;
}

/** The three-way choice the picker shows, read off the workspace an automation actually stores. */
function modeOf(workspace: Automation["workspace"]): WorkspaceMode {
  if (workspace.mode === "new_worktree") return "NewWorktree";
  if (workspace.mode === "path") return "ReuseWorkspace";
  return "RepositoryDirectory";
}

function workspaceFor(mode: WorkspaceMode, baseBranch: string): Automation["workspace"] {
  if (mode === "NewWorktree") return { mode: "new_worktree", base_branch: baseBranch };
  // Nothing is pinned yet, and an empty path is what the Save button refuses to write.
  if (mode === "ReuseWorkspace") return { mode: "path", path: "" };
  return { mode: "repository" };
}

function blank(workspaceMode: WorkspaceMode, baseBranch: string, agentId: string): Automation {
  return {
    id: newAutomationId(),
    // Both filled in by the server, which is the only side that can resolve a path or a schedule.
    project_path: "",
    next_due_at: null,
    name: "",
    prompt: "",
    agent_id: agentId,
    model: null,
    permission_mode: null,
    effort: null,
    cron: null,
    timezone: localTimezone(),
    enabled: true,
    workspace: workspaceFor(workspaceMode, baseBranch),
    webhook_enabled: false,
    webhook_overlap: "refuse",
  };
}

/**
 * Which clock the schedule is read against.
 *
 * Two places can disagree about what "09:00" is, and only two: this machine, and the one the agent
 * runs on. A local project has one machine, so there is nothing to ask and no control to show.
 *
 * A stored zone that is neither is kept and offered as it is — an automation written on another
 * machine, or by hand — rather than silently rescheduled onto whichever of the two is closest.
 */
function TimezoneField({
  value,
  serverTimezone,
  onChange,
}: {
  value: string;
  serverTimezone: string;
  onChange: (timezone: string) => void;
}) {
  const local = localTimezone();
  const choices = [
    { value: local, label: `This computer (${local})` },
    { value: serverTimezone, label: `Where it runs (${serverTimezone})` },
  ].filter((choice, index, all) => all.findIndex((c) => c.value === choice.value) === index);
  if (!choices.some((choice) => choice.value === value)) {
    choices.push({ value, label: `${value} (as saved)` });
  }
  if (choices.length < 2) return null;

  return (
    <label className="block space-y-1">
      <span className="text-[11px] text-muted-foreground">Read the time in</span>
      <Select value={value} onValueChange={(next) => next && onChange(next)}>
        <SelectTrigger size="sm" className="w-full text-xs" aria-label="Timezone">
          <span className="flex-1 truncate text-left">
            {choices.find((choice) => choice.value === value)?.label ?? value}
          </span>
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value} className="text-xs">
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

type Trigger = "manual" | "schedule" | "webhook";

const TRIGGERS: Array<{ value: Trigger; label: string; icon: LucideIcon; hint: string }> = [
  { value: "manual", label: "None", icon: Ban, hint: "It runs only when you press Run now." },
  {
    value: "schedule",
    label: "Schedule",
    icon: CalendarClock,
    hint: "Runs at set times.",
  },
  {
    value: "webhook",
    label: "Webhook",
    icon: Webhook,
    hint: "Runs when a service calls its URL.",
  },
];

function triggerOf(automation: Automation): Trigger {
  if (automation.cron != null) return "schedule";
  return automation.webhook_enabled ? "webhook" : "manual";
}

/**
 * What starts the automation besides Run now: a schedule or a webhook, never both, since those
 * would be two jobs sharing one name, one history and one workspace.
 *
 * `enabled` is the row's switch, which pauses whichever it is, so it is not written here. The
 * last expression is remembered while the dialog is open, so going to Webhook and back finds the
 * same schedule; saving with another choice forgets it.
 */
function TriggerSection({
  projectId,
  connection,
  automation,
  saved,
  template,
  serverTimezone,
  onChange,
}: {
  projectId: number;
  connection: ConnectionKey;
  automation: Automation;
  saved: boolean;
  template: boolean;
  serverTimezone: string;
  onChange: (fields: Partial<Automation>) => void;
}) {
  const trigger = triggerOf(automation);
  const [lastCron, setLastCron] = useState(automation.cron);
  const { data: server } = useBackgroundServerQuery(connection);

  const choose = (next: Trigger) => {
    if (automation.cron != null) setLastCron(automation.cron);
    onChange({
      // Starting a schedule with nothing remembered lands somewhere valid rather than on five
      // stars, which is a schedule that fires every minute.
      cron: next === "schedule" ? (lastCron ?? DEFAULT_CRON) : null,
      webhook_enabled: next === "webhook",
    });
  };

  return (
    <div className="space-y-2">
      <span className="text-[11px] text-muted-foreground">Trigger</span>
      <ToggleGroup
        value={[trigger]}
        onValueChange={(values) => {
          const next = values.find((value) => value !== trigger) as Trigger | undefined;
          if (next) choose(next);
        }}
        className="w-full"
      >
        {TRIGGERS.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            size="sm"
            variant="outline"
            className="flex-1 gap-1.5 text-xs"
          >
            <option.icon className="size-3.5" />
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p className="text-[11px] text-muted-foreground/70">
        {TRIGGERS.find((option) => option.value === trigger)?.hint}
      </p>

      {trigger === "schedule" && (
        <>
          <CronEditor
            projectId={projectId}
            cron={automation.cron ?? DEFAULT_CRON}
            timezone={automation.timezone}
            onChange={(cron) => onChange({ cron })}
          />
          <TimezoneField
            value={automation.timezone}
            serverTimezone={serverTimezone}
            onChange={(timezone) => onChange({ timezone })}
          />
          <p className="text-[11px] text-muted-foreground/70">
            It runs in the background whether or not Maestro is open, but a time that passes while
            that machine is off is skipped rather than caught up.
          </p>
        </>
      )}

      {trigger === "webhook" && (
        <WebhookSection
          projectId={projectId}
          connection={connection}
          automation={automation}
          saved={saved}
          template={template}
          onChange={onChange}
        />
      )}

      {!template && trigger !== "manual" && server?.autostart === "off" && (
        <p className="text-[11px] text-muted-foreground/70">
          Fires only while the background server runs, which stops at logout or reboot. Turn on
          Start automatically under Settings, Background server, to keep it going.
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
  serverTimezone,
  editing,
  seed = null,
  template = false,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: number;
  projectPath: string;
  connection: ConnectionKey;
  agents: Array<{ id: string; name: string }>;
  worktrees: WorktreeWithStatus[];
  /** The zone the machine that runs these is set to. Equal to this one for a local project. */
  serverTimezone: string;
  /** The automation being edited, or null to create one. */
  editing: Automation | null;
  /** What a new one starts from instead of blank: a template's fields. */
  seed?: Partial<Automation> | null;
  /**
   * Editing a template, passed in as `editing`. Only what a template keeps is shown: the agent and
   * workspace are the project's, chosen each time the template is used.
   */
  template?: boolean;
  onSave: (automation: Automation) => void;
}) {
  const isGitRepo = useIsGitRepo();
  const { data: projectSettings } = useProjectSettings(projectId);
  const defaultBaseBranch = useDefaultBaseBranch(open ? projectId : null);
  // A non-git project has no worktree to offer and no branch to base one on, so it starts in the
  // only place it can run.
  const projectDefault = projectSettings?.default_workspace_mode ?? "NewWorktree";
  const defaultMode: WorkspaceMode = isGitRepo ? projectDefault : "RepositoryDirectory";
  const defaultAgent = projectSettings?.default_agent ?? "";

  const [draft, setDraft] = useState<Automation>(() => editing ?? blank(defaultMode, "", ""));
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Reopening shows what is stored rather than what was abandoned last time. Adjusted during
  // render rather than from an effect, which would paint one frame of the previous edit. Starts
  // closed so a dialog mounted open, as one from a template is, fills itself in the same way.
  const [wasOpen, setWasOpen] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      const next = editing ?? { ...blank(defaultMode, defaultBaseBranch, defaultAgent), ...seed };
      setDraft(next);
      // Open for a project with no default agent: there is nothing to run this with, and the
      // disabled Create button would be the only clue about where to fix that.
      setAdvancedOpen(!template && next.agent_id.trim().length === 0);
    }
  }

  // The agent query may land after the dialog opened. Filling it late means the disclosure opened
  // for a missing agent that now has one, so it folds away again.
  if (open && !editing && !draft.agent_id && defaultAgent) {
    setDraft((prev) => ({ ...prev, agent_id: defaultAgent }));
    setAdvancedOpen(false);
  }

  const reusable = worktrees.filter((w) => w.path !== projectPath);
  const patch = (fields: Partial<Automation>) => setDraft((prev) => ({ ...prev, ...fields }));

  const mode = modeOf(draft.workspace);
  const pinnedPath = draft.workspace.mode === "path" ? draft.workspace.path : "";
  const baseBranch = draft.workspace.mode === "new_worktree" ? draft.workspace.base_branch : "";

  // What the disclosure hides, said on its own row: collapsed is only safe while the user can see
  // what they are collapsing over.
  const summary = [
    agents.find((a) => a.id === draft.agent_id)?.name || draft.agent_id || "no agent",
    draft.model,
    draft.permission_mode,
    !isGitRepo || mode === "RepositoryDirectory"
      ? "repository directory"
      : mode === "NewWorktree"
        ? `a worktree from ${baseBranch || "the current branch"}`
        : (reusable.find((w) => w.path === pinnedPath)?.branch_name ?? "no workspace"),
  ]
    .filter(Boolean)
    .join(" · ");

  const nameMissing = draft.name.trim().length === 0;
  const promptMissing = draft.prompt.trim().length === 0;
  const agentMissing = draft.agent_id.trim().length === 0;
  const workspaceMissing = mode === "ReuseWorkspace" && pinnedPath.length === 0;
  // A schedule that cannot be read would be refused by the server anyway, and storing it would
  // leave an automation that looks scheduled and never fires.
  const scheduleBroken = draft.cron != null && "error" in describeExpression(draft.cron);
  const canSave =
    !nameMissing &&
    !promptMissing &&
    !scheduleBroken &&
    (template || (!agentMissing && !workspaceMissing));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {template ? "Edit template" : editing ? "Edit automation" : "New automation"}
          </DialogTitle>
          <DialogDescription>
            {template
              ? "A template keeps the name, the prompt and the trigger. The agent and the workspace are chosen each time it is used."
              : "Give it a name, write in the prompt what it should do, and define which agent should do it and where it should run."}
          </DialogDescription>
        </DialogHeader>

        {/* min-w-0: the dialog is a grid, and a grid item will not shrink below a one-line secret. */}
        <div className="min-w-0 space-y-4">
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

          {/* Keyed by automation, so what a section remembers does not carry over to another. */}
          <TriggerSection
            key={draft.id}
            projectId={projectId}
            connection={connection}
            automation={draft}
            saved={editing !== null}
            template={template}
            serverTimezone={serverTimezone}
            onChange={patch}
          />

          {!template && (
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
                      value={mode}
                      // Writing the mode rebuilds the workspace, so switching away cannot leave a
                      // path behind that nothing will look at again.
                      onChange={(next) =>
                        patch({ workspace: workspaceFor(next, defaultBaseBranch) })
                      }
                      allowNewWorktree
                      hasReusableWorkspace={reusable.length > 0}
                    />

                    {mode === "NewWorktree" && (
                      <>
                        <BranchPicker
                          value={baseBranch}
                          prefix="From"
                          onChange={(branch) =>
                            patch({ workspace: { mode: "new_worktree", base_branch: branch } })
                          }
                          placeholder="The branch each run starts from"
                        />
                        <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                          Each run gets its own worktree and branch. It is removed when the run ends
                          with nothing to lose, and kept with a note when there is.
                        </p>
                      </>
                    )}

                    {mode === "ReuseWorkspace" && (
                      <Select
                        value={pinnedPath}
                        // The path, not the row id: the server acts on this and cannot read a row of
                        // ours to resolve one.
                        onValueChange={(path) =>
                          patch({ workspace: { mode: "path", path: path ?? "" } })
                        }
                      >
                        <SelectTrigger size="sm" className="w-full text-xs" aria-label="Workspace">
                          <span className="truncate flex-1 text-left">
                            {reusable.find((w) => w.path === pinnedPath)?.branch_name ??
                              "Select a workspace"}
                          </span>
                        </SelectTrigger>
                        <SelectContent>
                          {reusable.map((worktree) => (
                            <SelectItem
                              key={worktree.path}
                              value={worktree.path}
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
          )}
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
                // Whatever the machine is set to now, so a schedule keeps meaning what it looked
                // like when it was written rather than following the laptop across a border.
                timezone: draft.timezone || localTimezone(),
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
