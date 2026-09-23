import { useState } from "react";
import {
  Bot,
  ChevronDown,
  CornerDownRight,
  Ellipsis,
  FolderGit2,
  LayoutTemplate,
  MessageCircleQuestion,
  Pencil,
  Play,
  Square,
  Trash2,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import { Switch } from "@/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { api } from "@/lib/tauri-utils";
import { cn } from "@/lib/utils";
import {
  useAutomationRunEvents,
  useAutomationRunsQuery,
  useAutomationsQuery,
  useDeleteAutomationMutation,
  useDeleteAutomationRunMutation,
  useRunAutomationMutation,
  useSaveAutomationMutation,
  useSetRunRetentionMutation,
  useWebhookDeliveriesQuery,
} from "@/services/automation.service";
import { useAgentDiscoveryQuery } from "@/services/execution.service";
import { useWorktreesQuery } from "@/services/worktree.service";
import { useNavigate } from "@/store/navigationStore";
import { AutomationEditorDialog } from "./AutomationEditorDialog";
import { DeliveryRow, RunCard } from "./runs/RunCard";
import { automationHistory } from "./runs/deliveries";
import { RunsPanel, type RunFilter } from "./runs/RunsPanel";
import { RunDialog } from "./runs/RunDialog";
import { WebhookCreatedDialog } from "./WebhookSection";
import { SaveAsTemplateDialog } from "@/views/collections/templates/SaveAsTemplateDialog";
import { useNow } from "@/hooks/useNow";
import { useOpenRun, useRunEntries } from "./runs/useRunEntries";
import { describeNextRun, describeSchedule, localTimezone } from "./schedule";
import { keptCount, runDuration, waitDuration, type RunEntry } from "./runs/runs";
import type { Automation, AutomationRun, ConnectionKey } from "@/types/bindings";

function describeWorkspace(workspace: Automation["workspace"]): string {
  if (workspace.mode === "new_worktree") {
    return `New worktree from ${workspace.base_branch || "the current branch"}`;
  }
  if (workspace.mode === "path") return "Existing workspace";
  return "Repository directory";
}

function AutomationRow({
  projectId,
  automation,
  agents,
  running,
  runs,
  expanded,
  onToggleExpanded,
  onJoinRun,
  onShowRun,
  onDeleteRun,
  now,
  onRun,
  onEdit,
  onSaveAsTemplate,
  onDelete,
  onToggleEnabled,
}: {
  projectId: number;
  automation: Automation;
  agents: Array<{ id: string; name: string }>;
  /** The run in flight for this automation, if there is one. */
  running: AutomationRun | undefined;
  /** This automation's own runs, newest first. */
  runs: RunEntry[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onJoinRun: (entry: RunEntry) => void;
  onShowRun: (entry: RunEntry) => void;
  onDeleteRun: (entry: RunEntry) => void;
  /** The page's clock, shared so every duration moves together. */
  now: number;
  onRun: () => void;
  onEdit: () => void;
  onSaveAsTemplate: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}) {
  const navigate = useNavigate();

  const agentName = agents.find((a) => a.id === automation.agent_id)?.name ?? automation.agent_id;
  const sessionId = running?.session_id ?? null;
  const kept = keptCount(runs);
  const { data: deliveries } = useWebhookDeliveriesQuery(
    projectId,
    automation.webhook_enabled ? automation.id : null,
  );
  // Refused deliveries sit among the runs, since a webhook that did nothing is what a user comes
  // to this history to find out about.
  const history = automationHistory(runs, deliveries ?? []);
  const shown = history.slice(0, 5);
  const olderRuns = runs.length - shown.filter((item) => item.kind === "run").length;
  const hasTrigger = automation.cron != null || automation.webhook_enabled;
  // Whether the run in flight is blocked on a question is live session state, joined in by the
  // entry; the row is where it has to show, since the history is collapsed by default.
  const waiting = runs.find((entry) => entry.run.id === running?.id && entry.state === "awaiting");
  const awaiting = waiting !== undefined;

  // From the server, which is where the clock is. Nothing here works out when it is next due.
  const next = automation.next_due_at ? new Date(automation.next_due_at) : null;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <Switch
                // Off with no trigger, whatever `enabled` says: there is nothing to turn on.
                checked={automation.enabled && hasTrigger}
                onCheckedChange={onToggleEnabled}
                disabled={!hasTrigger}
                aria-label={`Enable ${automation.name}`}
                className="shrink-0 data-unchecked:border-border/50 data-unchecked:bg-muted"
              />
            }
          />
          <TooltipContent>
            {hasTrigger
              ? automation.enabled
                ? "Runs on its own. Turn off to pause its schedule and webhook."
                : "Paused: neither its schedule nor its webhook starts it. Run now still works."
              : "No trigger: it only runs when you press Run now. Give it a schedule or a webhook to turn it on."}
          </TooltipContent>
        </Tooltip>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {/* The whole name is the disclosure: runs are what a user comes to this row to see, and
              a chevron beside it would be a second, smaller target for the same thing. */}
            <button
              type="button"
              onClick={onToggleExpanded}
              disabled={history.length === 0}
              aria-expanded={expanded}
              className={cn(
                "flex min-w-0 items-center gap-1 text-left",
                history.length > 0 && "cursor-pointer",
              )}
            >
              {history.length > 0 && (
                <ChevronDown
                  className={cn(
                    "size-3 shrink-0 text-muted-foreground transition-transform",
                    !expanded && "-rotate-90",
                  )}
                />
              )}
              <span
                className={cn(
                  "truncate text-sm font-medium",
                  !automation.enabled && automation.cron && "text-muted-foreground",
                )}
              >
                {automation.name}
              </span>
            </button>
            {/* Status only: getting into the session is the button beside Stop. */}
            {running &&
              (waiting ? (
                <span className="flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">
                  <MessageCircleQuestion className="size-2.5" />
                  waiting on you for {waitDuration(waiting, now)}
                </span>
              ) : (
                <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-600">
                  {sessionId ? `● running for ${runDuration(running, now)}` : "● starting"}
                </span>
              ))}
            {/* Workspaces a run could not clean up: the row is the only place this is visible
                without opening the history, and the work in them is nobody's but the user's. */}
            {kept > 0 && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={onToggleExpanded}
                      className="flex items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning hover:bg-warning/25"
                    />
                  }
                >
                  <FolderGit2 className="size-2.5" />
                  {kept} workspace{kept > 1 ? "s" : ""} kept
                </TooltipTrigger>
                <TooltipContent>
                  Runs that left work behind. Open the history to see which, and why.
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            {(automation.cron || !automation.webhook_enabled) && (
              <span className="rounded bg-muted/50 px-1.5 py-0.5">
                {describeSchedule(automation.cron)}
              </span>
            )}
            {automation.webhook_enabled && (
              <span className="flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5">
                <Webhook className="size-3" />
                Webhook
              </span>
            )}
            {next && <span>next {describeNextRun(next, new Date(now))}</span>}
            <span className="rounded bg-muted/50 px-1.5 py-0.5">{agentName}</span>
            {automation.model && (
              <span className="rounded bg-muted/50 px-1.5 py-0.5">{automation.model}</span>
            )}
            {automation.permission_mode && (
              <span className="rounded bg-muted/50 px-1.5 py-0.5">
                {automation.permission_mode}
              </span>
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
          <ButtonGroup className="shrink-0">
            <Button
              variant="outline"
              size="sm"
              disabled={sessionId === null}
              onClick={() => sessionId && navigate({ sessionId })}
              className={cn(
                "text-xs",
                awaiting &&
                  "border-amber-500 bg-amber-500/10 font-medium text-amber-600 hover:bg-amber-500/20 hover:text-amber-600",
              )}
            >
              {awaiting ? (
                <MessageCircleQuestion className="size-3" />
              ) : (
                <CornerDownRight className="size-3" />
              )}
              {awaiting ? "Answer" : "Join"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={sessionId === null}
              onClick={() => sessionId && void api.cancelAcpSession(sessionId)}
              className="text-xs"
            >
              <Square className="size-3" />
              Stop
            </Button>
          </ButtonGroup>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`More actions for ${automation.name}`}
            render={
              <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground" />
            }
          >
            <Ellipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto whitespace-nowrap">
            <DropdownMenuItem className="text-xs" onClick={onEdit}>
              <Pencil className="size-3.5" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs" onClick={onSaveAsTemplate}>
              <LayoutTemplate className="size-3.5" />
              Save as template
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" className="text-xs" onClick={onDelete}>
              <Trash2 className="size-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {expanded && history.length > 0 && (
        <div className="ml-6 mt-2">
          <div className="divide-y divide-border/60 overflow-hidden rounded-md border border-border bg-background">
            {shown.map((item) =>
              item.kind === "run" ? (
                <RunCard
                  key={item.entry.run.id}
                  entry={item.entry}
                  layout="row"
                  now={now}
                  onJoin={() => onJoinRun(item.entry)}
                  onShow={() => onShowRun(item.entry)}
                  onDelete={() => onDeleteRun(item.entry)}
                />
              ) : (
                <DeliveryRow key={item.delivery.id} delivery={item.delivery} now={now} />
              ),
            )}
          </div>
          {olderRuns > 0 && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              {olderRuns} older, in Recent runs
            </p>
          )}
        </div>
      )}
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
  seed,
  onEdit,
}: {
  projectId: number;
  projectPath: string;
  connection: ConnectionKey;
  editorOpen: boolean;
  onEditorOpenChange: (open: boolean) => void;
  /** The automation the editor is open on, or null when it is creating one. */
  editing: Automation | null;
  /** What a new one starts from, when it comes from a template. */
  seed: Partial<Automation> | null;
  onEdit: (automation: Automation) => void;
}) {
  const { data: list } = useAutomationsQuery(projectId);
  const { data: runs } = useAutomationRunsQuery(projectId);
  useAutomationRunEvents(projectId);
  const save = useSaveAutomationMutation();
  const remove = useDeleteAutomationMutation();
  const run = useRunAutomationMutation();
  const deleteRun = useDeleteAutomationRunMutation();
  const setRetention = useSetRunRetentionMutation();
  const onDeleteRun = (entry: RunEntry) => deleteRun.mutate({ projectId, runId: entry.run.id });
  const { data: discovery } = useAgentDiscoveryQuery(connection);
  const { data: worktrees } = useWorktreesQuery(projectId, projectPath);

  // One query feeds the rows and the panel, so the two can never disagree about a run they both
  // show. The panel groups all of it; a row filters it to its own.
  const entries = useRunEntries(projectId);
  const { open: openRun, loading: loadingRun } = useOpenRun(projectId, connection);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<RunFilter>("all");
  // By id rather than the entry itself, so the dialog follows the run as the list refreshes, and
  // closes on its own once the run is deleted.
  const [shownRunId, setShownRunId] = useState<string | null>(null);
  const [webhookCreated, setWebhookCreated] = useState<Automation | null>(null);
  const [templateFrom, setTemplateFrom] = useState<Automation | null>(null);
  const shownRun = entries.find((entry) => entry.run.id === shownRunId) ?? null;
  const automations = list?.automations;
  const agents = discovery?.agents ?? [];
  const running = new Map(
    (runs ?? []).filter((r) => r.status === "running").map((r) => [r.automation_id, r]),
  );
  // One clock for every duration on the page. Every second while something is running, since those
  // durations count in seconds; a coarser tick froze a just-started run at 0s until the next one.
  const now = useNow(running.size > 0 ? 1_000 : 30_000);

  return (
    <div className="flex h-full min-w-0 flex-1">
      {/* Its own top edge, rounding away from Recent runs on its right and the sidebar on its left. */}
      <div className="flex h-full min-w-0 flex-1 flex-col gap-3 overflow-y-auto rounded-tl-xl border-l border-t border-border bg-background p-4 rounded-tr-xl border-r">
        {(automations ?? []).length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <Bot className="size-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">No automations yet</p>
            <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
              An automation will run your prompt on demand or on a schedule, in the background and
              whether or not Maestro is open. You decide what it does and what it produces. You can
              either create one by pressing &ldquo;New automation&rdquo; or ask an agent to guide
              you through it.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border bg-card">
            {(automations ?? []).map((automation) => (
              <AutomationRow
                key={automation.id}
                projectId={projectId}
                automation={automation}
                agents={agents}
                running={running.get(automation.id)}
                runs={entries.filter((entry) => entry.run.automation_id === automation.id)}
                now={now}
                expanded={expanded === automation.id}
                onToggleExpanded={() =>
                  setExpanded((open) => (open === automation.id ? null : automation.id))
                }
                onJoinRun={(entry) => void openRun(entry)}
                onShowRun={(entry) => setShownRunId(entry.run.id)}
                onDeleteRun={onDeleteRun}
                onRun={() => run.mutate({ projectId, automationId: automation.id })}
                onEdit={() => onEdit(automation)}
                onSaveAsTemplate={() => setTemplateFrom(automation)}
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

        <SaveAsTemplateDialog automation={templateFrom} onClose={() => setTemplateFrom(null)} />

        <WebhookCreatedDialog
          automation={webhookCreated}
          connection={connection}
          onClose={() => setWebhookCreated(null)}
        />

        <RunDialog
          entry={shownRun}
          agentName={(agentId) => agents.find((agent) => agent.id === agentId)?.name ?? agentId}
          now={now}
          opening={shownRun !== null && loadingRun === shownRun.run.id}
          onOpenChange={(open) => !open && setShownRunId(null)}
          onOpenSession={(entry) => {
            void openRun(entry);
            setShownRunId(null);
          }}
          onDelete={onDeleteRun}
        />

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
          seed={seed}
          onSave={(automation) =>
            save.mutate(
              { projectId, automation },
              {
                // The first save with a webhook is what makes its secret, so it is shown now
                // rather than on reopening. One already on had it in the editor.
                onSuccess: (saved) => {
                  if (saved.webhook_enabled && !editing?.webhook_secret) setWebhookCreated(saved);
                },
              },
            )
          }
        />
      </div>

      <RunsPanel
        entries={entries}
        now={now}
        filter={filter}
        onFilterChange={setFilter}
        onJoin={(entry) => void openRun(entry)}
        onShow={(entry) => setShownRunId(entry.run.id)}
        onDelete={onDeleteRun}
        retention={list?.retention}
        onRetentionChange={(retention) => setRetention.mutate({ projectId, retention })}
      />
    </div>
  );
}
