import { useState, useEffect } from "react";
import { Terminal as TerminalIcon, GitBranch } from "lucide-react";
import { generateSessionName } from "@/lib/generateSessionName";
import { api } from "@/lib/tauri-utils";
import { cn } from "@/lib/ui-utils";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import {
  useSpawnInteractiveExecutionMutation,
  useSpawnAcpSessionMutation,
  useAgentDiscoveryQuery,
} from "@/services/execution.service";
import { useProjectSettings } from "@/services/project.service";
import { usePreflightToolChecks } from "@/store/configStore";
import type { WorktreeWithStatus } from "@/types/bindings";

interface SpawnSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: number;
  repoPath: string;
  connectionId: number | null;
  wslConnectionId: number | null;
  worktrees: WorktreeWithStatus[];
  onSuccess: (sessionKey: number) => void;
}

export function SpawnSessionDialog({
  open,
  onOpenChange,
  projectId,
  repoPath,
  connectionId,
  wslConnectionId,
  worktrees,
  onSuccess,
}: SpawnSessionDialogProps) {
  const [selectedWorktree, setSelectedWorktree] = useState<WorktreeWithStatus | null>(null);
  const [sessionName, setSessionName] = useState("");
  const [sessionType, setSessionType] = useState<string>("terminal");
  const [selectedModel, setSelectedModel] = useState<string>("");

  const { data: projectSettings } = useProjectSettings(projectId);
  const { data: discovery, isLoading: discoveryLoading } = useAgentDiscoveryQuery(connectionId, wslConnectionId);
  const spawnMutation = useSpawnInteractiveExecutionMutation();
  const spawnAcpMutation = useSpawnAcpSessionMutation();

  const toolChecks = usePreflightToolChecks(connectionId);
  const unavailableTools = new Set(toolChecks.filter((t) => !t.available).map((t) => t.tool));
  const visibleAgents = discovery?.agents ?? [];

  useEffect(() => {
    if (!open) return;
    setSelectedWorktree(worktrees[0] ?? null);
    setSessionName("");

    const defaultAgent = projectSettings?.default_agent;
    const agentExists = defaultAgent && visibleAgents.some((a) => a.id === defaultAgent);
    setSessionType(agentExists ? defaultAgent : "terminal");
    setSelectedModel(
      agentExists && projectSettings?.default_model ? projectSettings.default_model : "",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleSpawn() {
    if (!selectedWorktree) return;
    if (sessionType === "terminal") {
      spawnMutation.mutate(
        {
          projectId,
          branchName: selectedWorktree.branch_name,
          repoPath,
          sessionName: sessionName.trim() || generateSessionName(),
          worktreeId: selectedWorktree.id,
        },
        {
          onSuccess: (sessionKey) => {
            onOpenChange(false);
            onSuccess(sessionKey);
          },
        },
      );
    } else {
      spawnAcpMutation.mutate(
        {
          agentId: sessionType,
          cwd: selectedWorktree.path,
          sessionName: sessionName.trim() || generateSessionName(),
          projectId,
          connectionId,
          wslConnectionId,
          worktreeBranch: selectedWorktree.branch_name,
        },
        {
          onSuccess: (sessionKey) => {
            if (selectedModel) {
              api.setAcpModel(sessionKey, selectedModel).catch(() => {});
            }
            onOpenChange(false);
            onSuccess(sessionKey);
          },
        },
      );
    }
  }

  const isPending = spawnMutation.isPending || spawnAcpMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Session</DialogTitle>
          <p className="text-xs text-muted-foreground">
            Choose an agent and worktree to get started.
          </p>
        </DialogHeader>
        <div className="space-y-5 py-1">
          {/* Agent selection */}
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
              Agent
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => { setSessionType("terminal"); setSelectedModel(""); }}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-left transition-colors",
                  sessionType === "terminal"
                    ? "bg-accent/8 border-accent/30"
                    : "border-border/60 bg-transparent hover:bg-muted/20 hover:border-border",
                )}
              >
                <div className="w-7 h-7 rounded-md bg-muted/40 flex items-center justify-center shrink-0">
                  <TerminalIcon className="w-3.5 h-3.5 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <p className={cn("text-xs font-medium", sessionType === "terminal" && "text-accent")}>Terminal</p>
                  <p className="text-[10px] text-muted-foreground/60">Shell session</p>
                </div>
              </button>

              {discoveryLoading && (
                <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-border/40 opacity-50">
                  <div className="w-7 h-7 rounded-md bg-muted/30 animate-pulse shrink-0" />
                  <p className="text-xs text-muted-foreground">Loading...</p>
                </div>
              )}

              {visibleAgents.map((agent) => {
                const missingDeps = (agent.spawn_deps ?? []).filter((dep) => unavailableTools.has(dep));
                const disabled = missingDeps.length > 0;
                const isSelected = sessionType === agent.id;
                const isDefault = agent.id === projectSettings?.default_agent;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => { setSessionType(agent.id); setSelectedModel(""); }}
                    title={disabled ? `Requires ${missingDeps.join(", ")} (not available on this connection)` : undefined}
                    className={cn(
                      "flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-left transition-colors",
                      disabled
                        ? "opacity-40 cursor-not-allowed border-border/40 bg-transparent"
                        : isSelected
                          ? "bg-accent/8 border-accent/30"
                          : "border-border/60 bg-transparent hover:bg-muted/20 hover:border-border",
                    )}
                  >
                    <div className="w-7 h-7 rounded-md bg-muted/40 flex items-center justify-center shrink-0">
                      {agent.icon ? (
                        <img
                          src={agent.icon}
                          className="w-4 h-4 rounded-sm dark:[filter:invert(1)]"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                        />
                      ) : (
                        <span className="text-[10px] font-bold text-muted-foreground">
                          {agent.name[0]}
                        </span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className={cn("text-xs font-medium truncate", isSelected && "text-accent")}>{agent.name}</p>
                      {disabled ? (
                        <p className="text-[10px] text-muted-foreground/60 truncate">Needs {missingDeps.join(", ")}</p>
                      ) : isDefault ? (
                        <p className="text-[9px] font-medium text-accent/60">Default</p>
                      ) : null}
                    </div>
                  </button>
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

          {/* Worktree */}
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
              Worktree
            </p>
            <Select
              value={selectedWorktree?.branch_name ?? ""}
              onValueChange={(v) =>
                setSelectedWorktree(worktrees.find((wt) => wt.branch_name === v) ?? null)
              }
            >
              <SelectTrigger id="spawn-worktree" className="w-full">
                <span className="flex items-center gap-1.5 min-w-0">
                  <GitBranch className="w-3 h-3 text-muted-foreground/50 shrink-0" />
                  {selectedWorktree ? (
                    <>
                      <span className="font-mono text-sm truncate flex-1">{selectedWorktree.branch_name}</span>
                      {selectedWorktree.path === repoPath && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground/70 font-medium shrink-0">default</span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">Select a worktree</span>
                  )}
                </span>
              </SelectTrigger>
              <SelectContent>
                {worktrees.map((wt) => (
                  <SelectItem key={wt.branch_name} value={wt.branch_name}>
                    <span className="flex items-center gap-2">
                      <span className="font-mono">{wt.branch_name}</span>
                      {wt.path === repoPath && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground/70 font-medium">default</span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Session name */}
          <div className="space-y-1.5">
            <Label htmlFor="spawn-session-name" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
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
            />
            <p className="text-[10px] text-muted-foreground/40">Leave blank to auto-generate a name.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!selectedWorktree || isPending} onClick={handleSpawn}>
            {isPending ? "Starting..." : "Start Session"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
