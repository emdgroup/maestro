import { Bot, Pencil, Play, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { api } from "@/lib/tauri-utils";
import { cn } from "@/lib/utils";
import {
  useAutomationRunEvents,
  useAutomationRunsQuery,
  useAutomationsQuery,
  useDeleteAutomationMutation,
  useRunAutomationMutation,
  useSaveAutomationMutation,
} from "@/services/automation.service";
import { useAgentDiscoveryQuery } from "@/services/execution.service";
import { useWorktreesQuery } from "@/services/worktree.service";
import { useNavigate } from "@/store/navigationStore";
import { AutomationEditorDialog } from "./AutomationEditorDialog";
import { describeNextRun, describeSchedule, localTimezone } from "./schedule";
import type { Automation, AutomationRun, ConnectionKey } from "@/types/bindings";

function describeWorkspace(workspace: Automation["workspace"]): string {
  if (workspace.mode === "new_worktree") {
    return `New worktree from ${workspace.base_branch || "the default branch"}`;
  }
  if (workspace.mode === "path") return "Existing workspace";
  return "Repository directory";
}

function AutomationRow({
  automation,
  agents,
  running,
  onRun,
  onEdit,
  onDelete,
  onToggleEnabled,
}: {
  automation: Automation;
  agents: Array<{ id: string; name: string }>;
  /** The run in flight for this automation, if there is one. */
  running: AutomationRun | undefined;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}) {
  const navigate = useNavigate();

  const agentName = agents.find((a) => a.id === automation.agent_id)?.name ?? automation.agent_id;
  const sessionId = running?.session_id ?? null;

  // From the server, which is where the clock is. Nothing here works out when it is next due.
  const now = new Date();
  const next = automation.next_due_at ? new Date(automation.next_due_at) : null;

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Tooltip>
        <TooltipTrigger
          render={
            <Switch
              checked={automation.enabled}
              onCheckedChange={onToggleEnabled}
              disabled={!automation.cron}
              aria-label={`Enable ${automation.name}`}
              className="shrink-0 data-unchecked:border-border/50 data-unchecked:bg-muted"
            />
          }
        />
        <TooltipContent>
          {automation.cron
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
              !automation.enabled && automation.cron && "text-muted-foreground",
            )}
          >
            {automation.name}
          </span>
          {running &&
            (sessionId ? (
              <button
                type="button"
                onClick={() => navigate({ sessionId })}
                className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-600 hover:bg-emerald-500/25"
              >
                ● running, open session
              </button>
            ) : (
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-600">
                ● starting
              </span>
            ))}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="rounded bg-muted/50 px-1.5 py-0.5">
            {describeSchedule(automation.cron)}
          </span>
          {next && <span>next {describeNextRun(next, now)}</span>}
          <span className="rounded bg-muted/50 px-1.5 py-0.5">{agentName}</span>
          {automation.model && (
            <span className="rounded bg-muted/50 px-1.5 py-0.5">{automation.model}</span>
          )}
          {automation.permission_mode && (
            <span className="rounded bg-muted/50 px-1.5 py-0.5">{automation.permission_mode}</span>
          )}
          <span className="rounded bg-muted/50 px-1.5 py-0.5">
            {describeWorkspace(automation.workspace)}
          </span>
        </div>
      </div>

      {running === undefined ? (
        <Button variant="outline" size="sm" onClick={onRun} className="shrink-0 text-xs">
          <Play className="size-3" />
          Run now
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={sessionId === null}
          onClick={() => sessionId && void api.cancelAcpSession(sessionId)}
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
 * The project's automations, as the background server holds them.
 *
 * One row at a time, not a whole document: the store is a set of rows on the other side of the
 * connection, and two windows writing the whole list would overwrite each other's edits.
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
  const { data: list } = useAutomationsQuery(projectId);
  const { data: runs } = useAutomationRunsQuery(projectId);
  useAutomationRunEvents(projectId);
  const save = useSaveAutomationMutation();
  const remove = useDeleteAutomationMutation();
  const run = useRunAutomationMutation();
  const { data: discovery } = useAgentDiscoveryQuery(connection);
  const { data: worktrees } = useWorktreesQuery(projectId, projectPath);

  const automations = list?.automations;
  const agents = discovery?.agents ?? [];
  const running = new Map(
    (runs ?? []).filter((r) => r.status === "running").map((r) => [r.automation_id, r]),
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col gap-3 p-4">
      {(automations ?? []).length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <Bot className="size-8 text-muted-foreground/40" />
          <p className="text-sm font-medium">No automations yet</p>
          <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
            An automation will run your prompt on demand or on a schedule, in the background and
            whether or not Maestro is open. You decide what it does and what it produces. You can
            either create one by pressing &ldquo;New automation&rdquo; or ask an agent to guide you
            through it.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border bg-card">
          {(automations ?? []).map((automation) => (
            <AutomationRow
              key={automation.id}
              automation={automation}
              agents={agents}
              running={running.get(automation.id)}
              onRun={() => run.mutate({ projectId, automationId: automation.id })}
              onEdit={() => onEdit(automation)}
              onToggleEnabled={(enabled) =>
                save.mutate({ projectId, automation: { ...automation, enabled } })
              }
              onDelete={() => {
                remove.mutate(
                  { projectId, automationId: automation.id },
                  { onSuccess: () => toast.success(`Deleted “${automation.name}”`) },
                );
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
        // Until the list answers, the only honest answer is this machine's own, which is right for
        // every local project and is replaced the moment the server says otherwise.
        serverTimezone={list?.server_timezone ?? localTimezone()}
        editing={editing}
        onSave={(automation) => save.mutate({ projectId, automation })}
      />
    </div>
  );
}
