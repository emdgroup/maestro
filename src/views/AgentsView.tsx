import { useState, useEffect } from "react";
import { AgentMonitor, STATUS_FILTERS, STATUS_LABEL } from "@/components/execution/AgentMonitor";
import type { StatusFilter } from "@/components/execution/AgentMonitor";
import { usePendingAgentId, useNavigationActions } from "@/store/navigationStore";
import {
  useExecutionsWithTaskInfoQuery,
  useSpawnInteractiveExecutionMutation,
  useSpawnAcpSessionMutation,
  useDeleteExecutionMutation,
  useAgentDiscoveryQuery,
} from "@/services/execution.service";
import { useWorktreesQuery } from "@/services/worktree.service";
import type { WorktreeWithStatus } from "@/types/bindings";
import { Input } from "@/ui/input";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui";
import { SearchIcon } from "lucide-react";

interface AgentsViewProps {
  projectId?: number;
  repoPath?: string;
  connectionId?: number | null;
}

export const AgentsView: React.FC<AgentsViewProps> = ({ projectId, repoPath, connectionId }) => {
  const { data: executions = [] } = useExecutionsWithTaskInfoQuery(projectId);
  const pendingAgentId = usePendingAgentId();
  const { clearPendingAgent } = useNavigationActions();
  const [selectedExecutionId, setSelectedExecutionId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");

  const [showSpawnDialog, setShowSpawnDialog] = useState(false);
  const [selectedWorktree, setSelectedWorktree] = useState<WorktreeWithStatus | null>(null);
  const [sessionName, setSessionName] = useState("");
  // "terminal" or an agent id from registry
  const [sessionType, setSessionType] = useState<string>("terminal");

  const { data: worktrees = [] } = useWorktreesQuery(projectId, repoPath);
  const { data: discovery, isLoading: discoveryLoading } = useAgentDiscoveryQuery(
    connectionId ?? null,
    showSpawnDialog || !!connectionId,
  );
  const spawnMutation = useSpawnInteractiveExecutionMutation();
  const spawnAcpMutation = useSpawnAcpSessionMutation();
  const deleteMutation = useDeleteExecutionMutation();

  const visibleAgents = discovery?.agents ?? [];
  const agentIcons: Record<string, string> = Object.fromEntries(
    visibleAgents.filter((a) => a.icon).map((a) => [a.id, a.icon]),
  );

  useEffect(() => {
    if (pendingAgentId && executions.length > 0) {
      const match = executions.find((e) => String(e.task_id) === pendingAgentId);
      if (match) {
        setSelectedExecutionId(match.id);
        clearPendingAgent();
      }
    } else if (selectedExecutionId == null && executions.length > 0) {
      const running = executions.find((e) => e.status === "running");
      if (running) setSelectedExecutionId(running.id);
    }
  }, [executions, pendingAgentId, clearPendingAgent, selectedExecutionId]);

  function openSpawnDialog() {
    setSelectedWorktree(worktrees[0] ?? null);
    setSessionName("");
    setSessionType("terminal");
    setShowSpawnDialog(true);
  }

  function handleSpawn() {
    if (!selectedWorktree) return;
    if (sessionType === "terminal") {
      spawnMutation.mutate(
        {
          projectId: projectId!,
          branchName: selectedWorktree.branch_name,
          repoPath: repoPath!,
          sessionName: sessionName.trim() || null,
          worktreeId: selectedWorktree.id,
        },
        {
          onSuccess: (logId) => {
            setShowSpawnDialog(false);
            setSelectedExecutionId(logId);
          },
        },
      );
    } else {
      spawnAcpMutation.mutate(
        {
          agentId: sessionType,
          cwd: selectedWorktree.path,
          sessionName: sessionName.trim() || null,
          projectId: projectId!,
          connectionId: connectionId ?? null,
          worktreeBranch: selectedWorktree.branch_name,
        },
        {
          onSuccess: (logId) => {
            setShowSpawnDialog(false);
            setSelectedExecutionId(logId);
          },
        },
      );
    }
  }

  const isPending = spawnMutation.isPending || spawnAcpMutation.isPending;

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="h-12 border-b border-border bg-muted/30 flex items-center justify-between px-4 gap-2 shrink-0">
        <div className="flex items-center gap-2">
          <InputGroup>
            <InputGroupInput
              type="text"
              placeholder="Search sessions..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-48 text-sm"
            />
            <InputGroupAddon align="inline-start">
              <SearchIcon className="text-muted-foreground" />
            </InputGroupAddon>
          </InputGroup>
          <ToggleGroup variant="outline" size="sm" value={[statusFilter]}>
            {STATUS_FILTERS.map((f) => (
              <ToggleGroupItem
                key={f}
                value={f}
                pressed={statusFilter === f}
                onClick={() => setStatusFilter(f)}
                className="text-xs px-3"
              >
                {STATUS_LABEL[f] ?? f}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      {/* Agent monitor */}
      <div className="flex-1 min-h-0">
        <AgentMonitor
          executions={executions}
          selectedExecutionId={selectedExecutionId}
          onSelect={setSelectedExecutionId}
          search={search}
          statusFilter={statusFilter}
          onSpawn={openSpawnDialog}
          onDelete={(executionId) => {
            deleteMutation.mutate({ executionId });
            if (selectedExecutionId === executionId) setSelectedExecutionId(null);
          }}
          agentIcons={agentIcons}
          onReconnect={(execution) => {
            if (execution.branch_name && projectId != null && repoPath != null) {
              spawnMutation.mutate(
                {
                  projectId,
                  branchName: execution.branch_name,
                  repoPath,
                  sessionName: execution.session_name ?? null,
                  worktreeId: null,
                },
                {
                  onSuccess: (logId) => {
                    setSelectedExecutionId(logId);
                    deleteMutation.mutate({ executionId: execution.id });
                  },
                },
              );
            }
          }}
          onRestart={(execution) => {
            if (!execution.agent_id || projectId == null) return;
            const worktree = worktrees.find((wt) => wt.branch_name === execution.branch_name);
            if (!worktree) return;
            spawnAcpMutation.mutate(
              {
                agentId: execution.agent_id,
                cwd: worktree.path,
                sessionName: execution.session_name ?? null,
                projectId,
                connectionId: connectionId ?? null,
                worktreeBranch: worktree.branch_name,
              },
              {
                onSuccess: (logId) => {
                  setSelectedExecutionId(logId);
                  deleteMutation.mutate({ executionId: execution.id });
                },
              },
            );
          }}
          onOpenTerminal={(execution) => {
            if (projectId == null || repoPath == null) return;
            const worktree = worktrees.find((wt) => wt.branch_name === execution.branch_name);
            if (!worktree) return;
            spawnMutation.mutate(
              {
                projectId,
                branchName: worktree.branch_name,
                repoPath,
                sessionName: null,
                worktreeId: worktree.id,
              },
              { onSuccess: (logId) => setSelectedExecutionId(logId) },
            );
          }}
        />
      </div>

      {/* New Session dialog — Terminal or ACP agent */}
      <Dialog open={showSpawnDialog} onOpenChange={setShowSpawnDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Session</DialogTitle>
            <DialogDescription>
              Start a terminal session or spawn an AI agent in a worktree.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Session type: Terminal or agent from registry */}
            <div className="space-y-2">
              <Label htmlFor="spawn-type">Type</Label>
              <Select value={sessionType} onValueChange={(v) => v && setSessionType(v)}>
                <SelectTrigger id="spawn-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="terminal">Terminal</SelectItem>
                  {discoveryLoading && (
                    <SelectItem value="_loading" disabled>Checking available agents...</SelectItem>
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
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                          />
                        )}
                        {agent.name}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Worktree */}
            <div className="space-y-2">
              <Label htmlFor="spawn-worktree">Worktree</Label>
              <Select
                value={selectedWorktree?.branch_name ?? ""}
                onValueChange={(v) => setSelectedWorktree(worktrees.find((wt) => wt.branch_name === v) ?? null)}
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
                      {wt.agent_status === "running" && (
                        <span className="ml-2 text-xs text-green-500">running</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Session name */}
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
            <Button variant="outline" onClick={() => setShowSpawnDialog(false)}>
              Cancel
            </Button>
            <Button disabled={!selectedWorktree || isPending} onClick={handleSpawn}>
              {isPending ? "Spawning..." : "Spawn"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
