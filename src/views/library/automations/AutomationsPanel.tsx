import { useEffect } from "react";
import { Bot, Pencil, Play, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { api } from "@/lib/tauri-utils";
import { cn } from "@/lib/utils";
import { useAutomationsQuery, useSaveAutomationsMutation } from "@/services/automation.service";
import { useActiveSessionsQuery, useAgentDiscoveryQuery } from "@/services/execution.service";
import { useWorktreesQuery } from "@/services/worktree.service";
import { useRunAutomation } from "@/hooks/useRunAutomation";
import { useAutomationRun, useAutomationRunActions } from "@/store/automationRunStore";
import { useNavigate } from "@/store/navigationStore";
import { AutomationEditorDialog } from "./AutomationEditorDialog";
import { describeNextRun, describeSchedule, nextRun } from "./schedule";
import type { Automation, ConnectionKey } from "@/types/bindings";

function AutomationRow({
  automation,
  agents,
  onRun,
  onEdit,
  onDelete,
  onToggleEnabled,
}: {
  automation: Automation;
  agents: Array<{ id: string; name: string }>;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}) {
  const runningLogId = useAutomationRun(automation.id);
  const navigate = useNavigate();

  const agentName = agents.find((a) => a.id === automation.agent_id)?.name ?? automation.agent_id;
  const workspace =
    automation.workspace_mode === "NewWorktree"
      ? `New worktree from ${automation.base_branch || "the default branch"}`
      : automation.workspace_mode === "RepositoryDirectory"
        ? "Repository directory"
        : "Existing workspace";

  // Recomputed on render rather than stored: the row is the only thing that reads it, and a clock
  // the user cannot see move is not worth a timer.
  const now = new Date();
  const next = automation.schedule && automation.enabled ? nextRun(automation.schedule, now) : null;

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Tooltip>
        <TooltipTrigger
          render={
            <Switch
              checked={automation.enabled}
              onCheckedChange={onToggleEnabled}
              disabled={!automation.schedule}
              aria-label={`Enable ${automation.name}`}
              className="shrink-0 data-unchecked:border-border/50 data-unchecked:bg-muted"
            />
          }
        />
        <TooltipContent>
          {automation.schedule
            ? automation.enabled
              ? "On schedule. Turn off to stop it firing."
              : "Paused. Run now still works."
            : "Nothing to pause: this one only runs when you press Run now."}
        </TooltipContent>
      </Tooltip>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "truncate text-sm font-medium",
              !automation.enabled && automation.schedule && "text-muted-foreground",
            )}
          >
            {automation.name}
          </span>
          {runningLogId !== undefined && (
            <button
              type="button"
              onClick={() => navigate({ sessionId: runningLogId })}
              className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-600 hover:bg-emerald-500/25"
            >
              ● running, open session
            </button>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="rounded bg-muted/50 px-1.5 py-0.5">
            {describeSchedule(automation.schedule)}
          </span>
          {next && <span>next {describeNextRun(next, now)}</span>}
          <span className="rounded bg-muted/50 px-1.5 py-0.5">{agentName}</span>
          {automation.model && (
            <span className="rounded bg-muted/50 px-1.5 py-0.5">{automation.model}</span>
          )}
          {automation.permission_mode && (
            <span className="rounded bg-muted/50 px-1.5 py-0.5">{automation.permission_mode}</span>
          )}
          <span className="rounded bg-muted/50 px-1.5 py-0.5">{workspace}</span>
        </div>
      </div>

      {runningLogId === undefined ? (
        <Button variant="outline" size="sm" onClick={onRun} className="shrink-0 text-xs">
          <Play className="size-3" />
          Run now
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void api.cancelAcpSession(runningLogId)}
          className="shrink-0 text-xs"
        >
          <Square className="size-3" />
          Stop
        </Button>
      )}
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon" onClick={onEdit} aria-label="Edit" />}
        >
          <Pencil className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>Edit</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              onClick={onDelete}
              aria-label={`Delete ${automation.name}`}
              className="text-muted-foreground hover:text-destructive"
            />
          }
        >
          <Trash2 className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>Delete</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * The project's automations, from `.maestro/automations.json`.
 *
 * Whole-document writes, like the profiles editor: the list held here is the list that is written
 * back, so a hand-edited file is replaced wholesale rather than merged into.
 *
 * The editor's open state comes from the view, because the button that opens it sits in the view's
 * action bar; everything the editor needs to save is here.
 */
export function AutomationsPanel({
  projectId,
  projectPath,
  connection,
  editorOpen,
  onEditorOpenChange,
  editing,
  onEdit,
}: {
  projectId: number;
  projectPath: string;
  connection: ConnectionKey;
  editorOpen: boolean;
  onEditorOpenChange: (open: boolean) => void;
  /** The automation the editor is open on, or null when it is creating one. */
  editing: Automation | null;
  onEdit: (automation: Automation) => void;
}) {
  const { data: document } = useAutomationsQuery(projectId);
  const save = useSaveAutomationsMutation();
  const { data: discovery } = useAgentDiscoveryQuery(connection);
  const { data: worktrees } = useWorktreesQuery(projectId, projectPath);
  const { data: sessions } = useActiveSessionsQuery(projectId);
  const { observe } = useAutomationRunActions();
  const run = useRunAutomation(projectId, projectPath, connection);

  const automations = document?.automations ?? [];
  const agents = discovery?.agents ?? [];

  // One reconciliation for every run: a session that ended, crashed, or was closed from the Agents
  // tab all look the same here, which is the point.
  useEffect(() => {
    if (!sessions) return;
    observe(sessions.map((s) => s.session_id));
  }, [sessions, observe]);

  const write = (next: Automation[]) => save.mutate({ projectId, document: { automations: next } });

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col gap-3 p-4">
      {automations.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <Bot className="size-8 text-muted-foreground/40" />
          <p className="text-sm font-medium">No automations yet</p>
          <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
            An automation will run your prompt on demand or based on a schedule while Maestro is
            running. You decide what the automation does and what it produces. You can either create
            one manually by pressing &ldquo;New automation&rdquo; or ask an agent to guide you
            through it.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border bg-card">
          {automations.map((automation) => (
            <AutomationRow
              key={automation.id}
              automation={automation}
              agents={agents}
              onRun={() => void run(automation)}
              onEdit={() => onEdit(automation)}
              onToggleEnabled={(enabled) =>
                write(automations.map((a) => (a.id === automation.id ? { ...a, enabled } : a)))
              }
              onDelete={() => {
                write(automations.filter((a) => a.id !== automation.id));
                toast.success(`Deleted “${automation.name}”`);
              }}
            />
          ))}
        </div>
      )}

      <AutomationEditorDialog
        open={editorOpen}
        onOpenChange={onEditorOpenChange}
        projectId={projectId}
        projectPath={projectPath}
        connection={connection}
        agents={agents}
        worktrees={worktrees ?? []}
        editing={editing}
        onSave={(automation) => {
          const exists = automations.some((a) => a.id === automation.id);
          write(
            exists
              ? automations.map((a) => (a.id === automation.id ? automation : a))
              : [...automations, automation],
          );
        }}
      />
    </div>
  );
}
