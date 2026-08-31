import { useState, useEffect } from "react";
import { Terminal as TerminalIcon } from "lucide-react";
import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";
import {
  generateSessionName,
  slugifyName,
  validateBranchSuffix,
  MAESTRO_BRANCH_PREFIX,
} from "@/lib/generateSessionName";
import { findBranchConflict } from "@/components/common/workspace-mode/branch-conflict";
import { cn } from "@/lib/utils.ts";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { WorkspaceSelector } from "@/components/common/workspace-mode/WorkspaceSelector";
import {
  useSpawnInteractiveExecutionMutation,
  useSpawnAcpSessionMutation,
  useAgentDiscoveryQuery,
} from "@/services/execution.service";
import { useProjectSettings } from "@/services/project.service";
import { useProjectBranchesQuery } from "@/services/task.service";
import { useDefaultBaseBranch } from "@/hooks/useDefaultBaseBranch";
import { useResolveWorktree, type CreatedWorktree } from "@/utils/hooks/useResolveWorktree";
import { usePreflightToolChecks } from "@/store/configStore";
import { useIsGitRepo } from "@/store/projectStore";
import type {
  BranchMode,
  ConnectionKey,
  WorkspaceMode,
  WorktreeWithStatus,
} from "@/types/bindings";

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
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("NewWorktree");
  const [baseBranch, setBaseBranch] = useState("");
  const [branchMode, setBranchMode] = useState<BranchMode>("Create");
  const [branchSuffix, setBranchSuffix] = useState("");
  const [sessionName, setSessionName] = useState("");
  const [sessionType, setSessionType] = useState<string>("terminal");
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const { data: projectSettings } = useProjectSettings(projectId);
  const { data: discovery, isLoading: discoveryLoading } = useAgentDiscoveryQuery(connection);
  const { data: branchData } = useProjectBranchesQuery(projectId);
  const defaultBaseBranch = useDefaultBaseBranch(projectId);
  const spawnMutation = useSpawnInteractiveExecutionMutation();
  const spawnAcpMutation = useSpawnAcpSessionMutation();
  const { resolveWorktree, isCreatingWorktree } = useResolveWorktree();

  const isGitRepo = useIsGitRepo();
  const toolChecks = usePreflightToolChecks(connection);
  const unavailableTools = new Set(toolChecks.filter((t) => !t.available).map((t) => t.tool));
  const visibleAgents = discovery?.agents ?? [];

  // The repo root is a mode of its own, so it is not one of the workspaces to reuse.
  const reusableWorktrees = worktrees.filter((wt) => wt.path !== repoPath);
  // The main worktree carries the branch the project is checked out on, which a terminal spawn
  // needs even when the session runs in the repository directory.
  const mainWorktree = worktrees.find((wt) => wt.path === repoPath) ?? null;

  useEffect(() => {
    if (!open) return;
    setSelectedWorktree(reusableWorktrees[0] ?? null);
    setWorkspaceMode(projectSettings?.default_workspace_mode ?? "NewWorktree");
    setBaseBranch(defaultBaseBranch);
    setBranchMode("Create");
    setBranchSuffix("");
    setSessionName("");
    setSpawnError(null);

    const defaultAgent = projectSettings?.default_agent;
    const agentExists = defaultAgent && visibleAgents.some((a) => a.id === defaultAgent);
    setSessionType(agentExists ? defaultAgent : "terminal");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Fill defaults if worktrees or branches load after the dialog was already opened
  useEffect(() => {
    if (open && selectedWorktree === null && reusableWorktrees.length > 0) {
      setSelectedWorktree(reusableWorktrees[0]);
    }
  }, [open, reusableWorktrees, selectedWorktree]);

  useEffect(() => {
    if (open && !baseBranch && defaultBaseBranch) {
      setBaseBranch(defaultBaseBranch);
    }
  }, [open, defaultBaseBranch, baseBranch]);

  // A terminal attaches to an existing checkout only — the backend refuses to create one for it,
  // so the option is offered disabled and never honoured here.
  const isTerminal = sessionType === "terminal";
  const effectiveMode: WorkspaceMode =
    isTerminal && workspaceMode === "NewWorktree" ? "RepositoryDirectory" : workspaceMode;
  const creatingWorktree = isGitRepo && effectiveMode === "NewWorktree";

  async function handleSpawn() {
    setSpawnError(null);
    const resolvedName = sessionName.trim() || generateSessionName();

    // Resolve the target worktree: create a fresh one, or use the selected existing one.
    let worktree: { id: number | null; branchName: string | null; path: string };
    let created: CreatedWorktree | null = null;
    if (creatingWorktree) {
      try {
        // A name the user typed is used as typed; a generated one gets the backend's uniqueness
        // suffix, because two sessions off the same title would otherwise collide.
        const typed = branchSuffix.trim();
        const resolved = await resolveWorktree({
          projectId,
          repoPath,
          taskId: null,
          baseBranch,
          newBranchName:
            branchMode === "Checkout"
              ? null
              : `${MAESTRO_BRANCH_PREFIX}${typed || slugifyName(resolvedName) || generateSessionName()}`,
          uniqueSuffix: branchMode === "Create" && !typed,
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
    } else if (effectiveMode === "ReuseWorkspace") {
      worktree = {
        id: selectedWorktree?.id ?? null,
        branchName: selectedWorktree?.branch_name ?? null,
        path: selectedWorktree?.path ?? repoPath,
      };
    } else {
      // The repository directory. `mainWorktree` is absent in a non-git project, where there is no
      // branch to name and no terminal path that needs one.
      worktree = {
        id: mainWorktree?.id ?? null,
        branchName: mainWorktree?.branch_name ?? null,
        path: repoPath,
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

  const branchConflict =
    creatingWorktree && branchMode === "Checkout"
      ? findBranchConflict(baseBranch, worktrees, repoPath, branchData?.[0])
      : null;

  const canSpawn = !isGitRepo
    ? true
    : creatingWorktree
      ? !!baseBranch &&
        branchConflict === null &&
        (branchMode === "Checkout" || validateBranchSuffix(branchSuffix.trim()) === null)
      : effectiveMode === "ReuseWorkspace"
        ? !!selectedWorktree
        : // The repository directory always exists; a terminal additionally needs the branch it is
          // on, which comes from the main worktree row.
          !isTerminal || !!mainWorktree;

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
                  maestro-server not found, only Terminal available
                </p>
              )}
              {!discoveryLoading && discovery?.error && (
                <p className="text-[10px] text-destructive/80">
                  Discovery error: {discovery.error}
                </p>
              )}
            </div>

            {/* Workspace — the dropdown decides whether a branch or an existing worktree is
                picked underneath it. */}
            {isGitRepo && (
              <WorkspaceSelector
                mode={effectiveMode}
                onModeChange={setWorkspaceMode}
                baseBranch={baseBranch}
                onBaseBranchChange={setBaseBranch}
                branchMode={branchMode}
                onBranchModeChange={setBranchMode}
                branchSuffix={branchSuffix}
                onBranchSuffixChange={setBranchSuffix}
                // Only once the session has a name is there one to preview; until then it is
                // generated at spawn, and null gets the "auto-generated" placeholder instead.
                generatedBranchSuffix={slugifyName(sessionName) || null}
                worktrees={worktrees}
                repoPath={repoPath}
                selectedWorktreeId={selectedWorktree?.id ?? null}
                onSelectedWorktreeChange={setSelectedWorktree}
                allowNewWorktree={!isTerminal}
              />
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
              {/* No branch hint here any more: when a branch is being created the workspace
                  section shows the name as an editable field, whose placeholder is this. */}
              <p className="text-[10px] text-muted-foreground/40">
                Leave blank to auto-generate a name.
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
