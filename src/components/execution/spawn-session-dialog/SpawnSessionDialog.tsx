import { useState, useEffect } from "react";
import { Terminal as TerminalIcon, Folder } from "lucide-react";
import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { generateSessionName, slugifyName, MAESTRO_BRANCH_PREFIX } from "@/lib/generateSessionName";
import { cn } from "@/lib/utils.ts";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { BranchPicker } from "@/components/kanban/shared/BranchPicker";
import {
  useSpawnInteractiveExecutionMutation,
  useSpawnAcpSessionMutation,
  useAgentDiscoveryQuery,
} from "@/services/execution.service";
import { useProjectSettings } from "@/services/project.service";
import { useProjectBranchesQuery } from "@/services/task.service";
import { useResolveWorktree, type CreatedWorktree } from "@/utils/hooks/useResolveWorktree";
import { usePreflightToolChecks } from "@/store/configStore";
import { useIsGitRepo } from "@/store/projectStore";
import type { ConnectionKey, WorktreeWithStatus } from "@/types/bindings";

export type { CreatedWorktree };

interface SpawnSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: number;
  repoPath: string;
  connection: ConnectionKey;
  worktrees: WorktreeWithStatus[];
  onSuccess: (sessionKey: number, createdWorktree: CreatedWorktree | null) => void;
}

export function SpawnSessionDialog({
  open,
  onOpenChange,
  projectId,
  repoPath,
  connection,
  worktrees,
  onSuccess,
}: SpawnSessionDialogProps) {
  const [selectedWorktree, setSelectedWorktree] = useState<WorktreeWithStatus | null>(null);
  const [newWorktree, setNewWorktree] = useState(true);
  const [baseBranch, setBaseBranch] = useState("");
  const [sessionName, setSessionName] = useState("");
  const [sessionType, setSessionType] = useState<string>("terminal");
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const { data: projectSettings } = useProjectSettings(projectId);
  const { data: discovery, isLoading: discoveryLoading } = useAgentDiscoveryQuery(connection);
  const { data: branchData } = useProjectBranchesQuery(projectId);
  const spawnMutation = useSpawnInteractiveExecutionMutation();
  const spawnAcpMutation = useSpawnAcpSessionMutation();
  const { resolveWorktree, isCreatingWorktree } = useResolveWorktree();

  const isGitRepo = useIsGitRepo();
  const toolChecks = usePreflightToolChecks(connection);
  const unavailableTools = new Set(toolChecks.filter((t) => !t.available).map((t) => t.tool));
  const visibleAgents = discovery?.agents ?? [];

  useEffect(() => {
    if (!open) return;
    setSelectedWorktree(worktrees[0] ?? null);
    setNewWorktree(projectSettings?.default_worktree ?? true);
    setBaseBranch(branchData?.[1] ?? "");
    setSessionName("");
    setSpawnError(null);

    const defaultAgent = projectSettings?.default_agent;
    const agentExists = defaultAgent && visibleAgents.some((a) => a.id === defaultAgent);
    setSessionType(agentExists ? defaultAgent : "terminal");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Fill defaults if worktrees or branches load after the dialog was already opened
  useEffect(() => {
    if (open && selectedWorktree === null && worktrees.length > 0) {
      setSelectedWorktree(worktrees[0]);
    }
  }, [open, worktrees, selectedWorktree]);

  useEffect(() => {
    if (open && !baseBranch && branchData?.[1]) {
      setBaseBranch(branchData[1]);
    }
  }, [open, branchData, baseBranch]);

  // A terminal attaches to an existing checkout only — the backend refuses to create one for it,
  // so the option is neither offered nor honoured here.
  const isTerminal = sessionType === "terminal";
  const creatingWorktree = isGitRepo && newWorktree && !isTerminal;

  async function handleSpawn() {
    setSpawnError(null);
    const resolvedName = sessionName.trim() || generateSessionName();

    // Resolve the target worktree: create a fresh one, or use the selected existing one.
    let worktree: { id: number | null; branchName: string | null; path: string };
    let created: CreatedWorktree | null = null;
    if (creatingWorktree) {
      try {
        const resolved = await resolveWorktree({
          projectId,
          repoPath,
          taskId: null,
          baseBranch,
          newBranchName: `${MAESTRO_BRANCH_PREFIX}${slugifyName(resolvedName) || generateSessionName()}`,
        });
        created = resolved.created;
        worktree = {
          id: created?.id ?? null,
          branchName: resolved.branchName,
          path: resolved.cwd,
        };
      } catch (error) {
        setSpawnError(String(error));
        return;
      }
    } else {
      worktree = {
        id: selectedWorktree?.id ?? null,
        branchName: selectedWorktree?.branch_name ?? null,
        path: selectedWorktree?.path ?? repoPath,
      };
    }

    if (sessionType === "terminal") {
      if (worktree.branchName === null) return;
      spawnMutation.mutate(
        {
          projectId,
          branchName: worktree.branchName,
          repoPath,
          sessionName: resolvedName,
          worktreeId: worktree.id,
        },
        {
          onSuccess: (sessionKey) => {
            onOpenChange(false);
            onSuccess(sessionKey, created);
          },
          onError: (error) => setSpawnError(String(error)),
        },
      );
    } else {
      spawnAcpMutation.mutate(
        {
          agentId: sessionType,
          cwd: worktree.path,
          sessionName: resolvedName,
          projectId,
          connection,
          worktreeBranch: worktree.branchName,
        },
        {
          onSuccess: (result) => {
            onOpenChange(false);
            onSuccess(result.log_id, created);
          },
          onError: (error) => setSpawnError(String(error)),
        },
      );
    }
  }

  const canSpawn = creatingWorktree
    ? !!baseBranch
    : isTerminal
      ? !!selectedWorktree
      : !isGitRepo || !!selectedWorktree;

  const isPending = spawnMutation.isPending || spawnAcpMutation.isPending || isCreatingWorktree;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Session</DialogTitle>
          <p className="text-xs text-muted-foreground">
            {isGitRepo
              ? "Choose an agent and worktree to get started."
              : "Choose an agent to get started."}
          </p>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSpawn && !isPending) void handleSpawn();
          }}
        >
          <div className="space-y-5 py-1">
            {/* Agent selection */}
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                Agent
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSessionType("terminal");
                  }}
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2.5 h-auto rounded-lg border text-left justify-start transition-colors",
                    sessionType === "terminal"
                      ? "bg-accent/8 border-accent/30"
                      : "border-border/60 hover:bg-muted/20 hover:border-border",
                  )}
                >
                  <div className="w-7 h-7 rounded-md bg-muted/40 border border-border flex items-center justify-center shrink-0">
                    <TerminalIcon className="w-3.5 h-3.5 text-accent" />
                  </div>
                  <div className="min-w-0">
                    <p
                      className={cn(
                        "text-xs font-medium",
                        sessionType === "terminal" && "text-accent",
                      )}
                    >
                      Terminal
                    </p>
                    <p className="text-[10px] text-muted-foreground/60">Shell session</p>
                  </div>
                </Button>

                {discoveryLoading && (
                  <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-border/40 opacity-50">
                    <div className="w-7 h-7 rounded-md bg-muted/30 animate-pulse shrink-0" />
                    <p className="text-xs text-muted-foreground">Loading...</p>
                  </div>
                )}

                {visibleAgents.map((agent) => {
                  const missingDeps = (agent.spawn_deps ?? []).filter((dep) =>
                    unavailableTools.has(dep),
                  );
                  const disabled = missingDeps.length > 0;
                  const isSelected = sessionType === agent.id;
                  const isDefault = agent.id === projectSettings?.default_agent;
                  return (
                    <Button
                      key={agent.id}
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => {
                        setSessionType(agent.id);
                      }}
                      title={
                        disabled
                          ? `Requires ${missingDeps.join(", ")} (not available on this connection)`
                          : undefined
                      }
                      className={cn(
                        "flex items-center gap-2.5 px-3 py-2.5 h-auto rounded-lg border text-left justify-start transition-colors",
                        disabled
                          ? "opacity-40 cursor-not-allowed border-border/40"
                          : isSelected
                            ? "bg-accent/8 border-accent/30"
                            : "border-border/60 hover:bg-muted/20 hover:border-border",
                      )}
                    >
                      <div className="w-7 h-7 rounded-md border border-border bg-muted/40 flex items-center justify-center shrink-0">
                        {hasBrandIcon(agent.id) ? (
                          <BrandIcon slug={agent.id} className="w-4 h-4" />
                        ) : agent.icon ? (
                          <img
                            src={agent.icon}
                            className="w-4 h-4 rounded-sm border border-border dark:filter-[invert(1)]"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.display = "none";
                            }}
                          />
                        ) : (
                          <span className="text-[10px] font-bold text-muted-foreground">
                            {agent.name[0]}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p
                          className={cn(
                            "text-xs font-medium truncate",
                            isSelected && "text-accent",
                          )}
                        >
                          {agent.name}
                        </p>
                        {disabled ? (
                          <p className="text-[10px] text-muted-foreground/60 truncate">
                            Needs {missingDeps.join(", ")}
                          </p>
                        ) : isDefault ? (
                          <p className="text-[9px] font-medium text-accent/60">Default</p>
                        ) : null}
                      </div>
                    </Button>
                  );
                })}
              </div>

              {!discoveryLoading && !discovery?.maestro_server_available && (
                <p className="text-[10px] text-muted-foreground/60">
                  maestro-server not found — only Terminal available
                </p>
              )}
              {!discoveryLoading && discovery?.error && (
                <p className="text-[10px] text-destructive/80">
                  Discovery error: {discovery.error}
                </p>
              )}
            </div>

            {/* Worktree — the New/Existing toggle decides whether the selector lists branches
                or worktrees; in New mode the picker is prefixed "From" to mark it as the base. */}
            {isGitRepo && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                    Worktree
                  </p>
                  {!isTerminal && (
                    <div className="flex gap-0.5 rounded-full bg-muted p-0.5">
                      {([true, false] as const).map((isNew) => (
                        <button
                          key={String(isNew)}
                          type="button"
                          onClick={() => setNewWorktree(isNew)}
                          className={cn(
                            "rounded-full px-2.5 py-[3px] text-[10px] font-medium transition-colors",
                            newWorktree === isNew
                              ? "bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.35)]"
                              : "text-muted-foreground hover:text-foreground/80",
                          )}
                        >
                          {isNew ? "New" : "Existing"}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {creatingWorktree ? (
                  <BranchPicker value={baseBranch} onChange={setBaseBranch} prefix="From" />
                ) : (
                  <Select
                    value={selectedWorktree?.branch_name ?? ""}
                    onValueChange={(v) =>
                      setSelectedWorktree(worktrees.find((wt) => wt.branch_name === v) ?? null)
                    }
                  >
                    <SelectTrigger
                      id="spawn-worktree"
                      className="w-full gap-2 px-3 border-border bg-transparent shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
                    >
                      <span className="flex items-center gap-2 min-w-0 flex-1">
                        <Folder className="size-3.5 text-muted-foreground shrink-0" />
                        {selectedWorktree ? (
                          <>
                            <span className="text-sm truncate flex-1 text-left">
                              {selectedWorktree.branch_name}
                            </span>
                            {selectedWorktree.path === repoPath && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground/70 font-medium shrink-0">
                                default
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">Select a worktree</span>
                        )}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {worktrees.map((wt) => (
                        <SelectItem
                          key={wt.branch_name}
                          value={wt.branch_name}
                          className="[&>div]:overflow-hidden"
                        >
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span className="flex items-center gap-2 min-w-0 overflow-hidden" />
                              }
                            >
                              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                              <span className="flex-1 truncate">{wt.branch_name}</span>
                              {wt.path === repoPath && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground/70 font-medium shrink-0">
                                  default
                                </span>
                              )}
                            </TooltipTrigger>
                            <TooltipContent side="top" sideOffset={8} className="max-w-none">
                              <span className="font-mono">{wt.branch_name}</span>
                            </TooltipContent>
                          </Tooltip>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {/* Session name */}
            <div className="space-y-1.5">
              <Label
                htmlFor="spawn-session-name"
                className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50"
              >
                Session name{" "}
                <span className="normal-case tracking-normal font-normal text-muted-foreground/40">
                  (optional)
                </span>
              </Label>
              <Input
                id="spawn-session-name"
                className="h-9 text-sm"
                placeholder="Auto-generated if blank"
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                autoFocus
              />
              <p className="text-[10px] text-muted-foreground/40">
                {creatingWorktree
                  ? `Also names the branch: ${MAESTRO_BRANCH_PREFIX}${slugifyName(sessionName) || "<generated>"}`
                  : "Leave blank to auto-generate a name."}
              </p>
            </div>

            {spawnError && <p className="text-xs text-destructive">{spawnError}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSpawn || isPending}>
              {isPending ? "Starting..." : "Start Session"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
