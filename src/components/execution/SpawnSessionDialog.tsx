import { useState, useEffect } from "react";
import { generateSessionName } from "@/lib/generateSessionName";
import { api } from "@/lib/tauri-utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import {
  useSpawnInteractiveExecutionMutation,
  useSpawnAcpSessionMutation,
  useAgentDiscoveryQuery,
  useAgentModelsCacheQuery,
} from "@/services/execution.service";
import { useProjectSettings } from "@/services/project.service";
import type { WorktreeWithStatus } from "@/types/bindings";

interface SpawnSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: number;
  repoPath: string;
  connectionId: number | null;
  worktrees: WorktreeWithStatus[];
  onSuccess: (sessionKey: number) => void;
}

export function SpawnSessionDialog({
  open,
  onOpenChange,
  projectId,
  repoPath,
  connectionId,
  worktrees,
  onSuccess,
}: SpawnSessionDialogProps) {
  const [selectedWorktree, setSelectedWorktree] = useState<WorktreeWithStatus | null>(null);
  const [sessionName, setSessionName] = useState("");
  const [sessionType, setSessionType] = useState<string>("terminal");
  const [selectedModel, setSelectedModel] = useState<string>("");

  const { data: projectSettings } = useProjectSettings(projectId);
  const { data: discovery, isLoading: discoveryLoading } = useAgentDiscoveryQuery(connectionId);
  const spawnMutation = useSpawnInteractiveExecutionMutation();
  const spawnAcpMutation = useSpawnAcpSessionMutation();

  const acpAgentId = sessionType !== "terminal" ? sessionType : null;
  const { data: modelsCache } = useAgentModelsCacheQuery(projectId, acpAgentId);
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
          worktreeBranch: selectedWorktree.branch_name,
        },
        {
          onSuccess: async (sessionKey) => {
            if (selectedModel) {
              try {
                await api.setAcpModel(sessionKey, selectedModel);
              } catch {
                /* ignore */
              }
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Session</DialogTitle>
          <DialogDescription>
            Start a terminal session or spawn an AI agent in a worktree.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="spawn-type">Type</Label>
            <Select
              value={sessionType}
              onValueChange={(v) => {
                if (v) {
                  setSessionType(v);
                  setSelectedModel("");
                }
              }}
            >
              <SelectTrigger id="spawn-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="terminal">Terminal</SelectItem>
                {discoveryLoading && (
                  <SelectItem value="_loading" disabled>
                    Checking available agents...
                  </SelectItem>
                )}
                {!discoveryLoading && !discovery?.maestro_server_available && (
                  <SelectItem value="_no_server" disabled>
                    maestro-server not found
                  </SelectItem>
                )}
                {!discoveryLoading && discovery?.error && (
                  <SelectItem value="_error" disabled>
                    Discovery error: {discovery.error}
                  </SelectItem>
                )}
                {visibleAgents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    <div className="flex items-center gap-2">
                      {agent.icon && (
                        <img
                          src={agent.icon}
                          className="w-4 h-4 rounded-sm shrink-0 brightness-0 dark:invert"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = "none";
                          }}
                        />
                      )}
                      {agent.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {sessionType !== "terminal" && (
            <div className="space-y-2">
              <Label htmlFor="spawn-model">Model (optional)</Label>
              <Select value={selectedModel} onValueChange={(v) => setSelectedModel(v ?? "")}>
                <SelectTrigger id="spawn-model">
                  <SelectValue placeholder="Agent default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Agent default</SelectItem>
                  {(modelsCache?.models ?? []).map((m) => (
                    <SelectItem key={m.model_id} value={m.model_id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="spawn-worktree">Worktree</Label>
            <Select
              value={selectedWorktree?.branch_name ?? ""}
              onValueChange={(v) =>
                setSelectedWorktree(worktrees.find((wt) => wt.branch_name === v) ?? null)
              }
            >
              <SelectTrigger id="spawn-worktree">
                <SelectValue placeholder="Select a worktree" />
              </SelectTrigger>
              <SelectContent>
                {worktrees.map((wt) => (
                  <SelectItem key={wt.branch_name} value={wt.branch_name}>
                    <span className="font-mono">{wt.branch_name}</span>
                    {wt.path === repoPath && (
                      <span className="ml-2 text-xs text-muted-foreground">main</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="spawn-session-name">Session name (optional)</Label>
            <Input
              id="spawn-session-name"
              placeholder="e.g. debugging, exploration"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!selectedWorktree || isPending} onClick={handleSpawn}>
            {isPending ? "Spawning..." : "Spawn"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
