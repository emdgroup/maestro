import { useState, useEffect } from "react";
import { generateSessionName } from "@/lib/generateSessionName";
import { AgentMonitor } from "@/components/execution/AgentMonitor";
import { SessionHistoryPanel } from "@/components/execution/SessionHistoryPanel";
import { usePendingAgentId, useNavigationActions } from "@/store/navigationStore";
import {
  useActiveSessionsQuery,
  useSpawnInteractiveExecutionMutation,
  useSpawnAcpSessionMutation,
  useAgentDiscoveryQuery,
  useAgentModelsCacheQuery,
  useCancelActiveSessionMutation,
} from "@/services/execution.service";
import { useWorktreesQuery } from "@/services/worktree.service";
import { useProjectSettings } from "@/services/project.service";
import type { ActiveSessionInfo, WorktreeWithStatus } from "@/types/bindings";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui";
import { Clock, SearchIcon } from "lucide-react";

interface AgentsViewProps {
  projectId?: number;
  repoPath?: string;
  connectionId?: number | null;
}

export const AgentsView: React.FC<AgentsViewProps> = ({ projectId, repoPath, connectionId }) => {
  const { data: sessions = [] } = useActiveSessionsQuery();
  const pendingAgentId = usePendingAgentId();
  const { clearPendingAgent } = useNavigationActions();
  const [selectedSessionKey, setSelectedSessionKey] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const [showHistory, setShowHistory] = useState(false);
  const [showSpawnDialog, setShowSpawnDialog] = useState(false);
  const [selectedWorktree, setSelectedWorktree] = useState<WorktreeWithStatus | null>(null);
  const [sessionName, setSessionName] = useState("");
  const [sessionType, setSessionType] = useState<string>("terminal");
  const [selectedModel, setSelectedModel] = useState<string>("");

  const { data: worktrees = [] } = useWorktreesQuery(projectId, repoPath);
  const { data: projectSettings } = useProjectSettings(projectId ?? 0);
  const { data: discovery, isLoading: discoveryLoading } = useAgentDiscoveryQuery(
    connectionId ?? null,
  );
  const spawnMutation = useSpawnInteractiveExecutionMutation();
  const spawnAcpMutation = useSpawnAcpSessionMutation();
  const cancelMutation = useCancelActiveSessionMutation();
  const acpAgentId = sessionType !== "terminal" ? sessionType : null;
  const { data: modelsCache } = useAgentModelsCacheQuery(projectId ?? 0, acpAgentId);

  const lastAcpAgentId = [...sessions].reverse().find((s) => s.execution_mode === "acp")?.agent_id ?? null;

  const visibleAgents = discovery?.agents ?? [];
  const agentIcons: Record<string, string> = Object.fromEntries(
    visibleAgents.filter((a) => a.icon).map((a) => [a.id, a.icon]),
  );

  useEffect(() => {
    if (pendingAgentId && sessions.length > 0) {
      const match = sessions.find((s) => String(s.task_id) === pendingAgentId);
      if (match) {
        setSelectedSessionKey(match.session_key);
        clearPendingAgent();
      }
    } else if (selectedSessionKey == null && sessions.length > 0) {
      setSelectedSessionKey(sessions[0].session_key);
    }
  }, [sessions, pendingAgentId, clearPendingAgent, selectedSessionKey]);

  function handleCloseSession(session: ActiveSessionInfo) {
    cancelMutation.mutate(
      { sessionKey: session.session_key, executionMode: session.execution_mode },
      {
        onSuccess: () => {
          if (selectedSessionKey === session.session_key) setSelectedSessionKey(null);
        },
      },
    );
  }

  function openSpawnDialog() {
    setSelectedWorktree(worktrees[0] ?? null);
    setSessionName("");

    const defaultAgent = projectSettings?.default_agent;
    const agentExists = defaultAgent && visibleAgents.some((a) => a.id === defaultAgent);
    setSessionType(agentExists ? defaultAgent : "terminal");
    setSelectedModel(agentExists && projectSettings?.default_model ? projectSettings.default_model : "");

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
          sessionName: sessionName.trim() || generateSessionName(),
          worktreeId: selectedWorktree.id,
        },
        {
          onSuccess: (sessionKey) => {
            setShowSpawnDialog(false);
            setSelectedSessionKey(sessionKey);
          },
        },
      );
    } else {
      spawnAcpMutation.mutate(
        {
          agentId: sessionType,
          cwd: selectedWorktree.path,
          sessionName: sessionName.trim() || generateSessionName(),
          projectId: projectId!,
          connectionId: connectionId ?? null,
          worktreeBranch: selectedWorktree.branch_name,
        },
        {
          onSuccess: async (sessionKey) => {
            if (selectedModel) {
              try { await import("@/lib").then(({ api }) => api.setAcpModel(sessionKey, selectedModel)); } catch { /* ignore */ }
            }
            setShowSpawnDialog(false);
            setSelectedSessionKey(sessionKey);
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
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
              className="h-8 w-48 text-sm"
            />
            <InputGroupAddon align="inline-start">
              <SearchIcon className="text-muted-foreground" />
            </InputGroupAddon>
          </InputGroup>
        </div>
        <div className="flex items-center gap-2">
          {(discovery?.agents?.length ?? 0) > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => setShowHistory((v) => !v)}
            >
              <Clock className="w-3.5 h-3.5 mr-1" />
              History
            </Button>
          )}
        </div>
      </div>

      {/* Agent monitor */}
      <div className="flex-1 min-h-0 relative">
        <AgentMonitor
          sessions={sessions}
          selectedSessionKey={selectedSessionKey}
          onSelect={setSelectedSessionKey}
          search={search}
          onSpawn={openSpawnDialog}
          agentIcons={agentIcons}
          onClose={handleCloseSession}
          projectId={projectId}
          onOpenTerminal={(session) => {
            if (projectId == null || repoPath == null) return;
            const worktree = worktrees.find((wt) => wt.branch_name === session.branch_name);
            if (!worktree) return;
            spawnMutation.mutate(
              {
                projectId,
                branchName: worktree.branch_name,
                repoPath,
                sessionName: null,
                worktreeId: worktree.id,
              },
              { onSuccess: (key) => setSelectedSessionKey(key) },
            );
          }}
        />
        {showHistory && visibleAgents.length > 0 && (
          <SessionHistoryPanel
            agents={visibleAgents}
            defaultAgentId={lastAcpAgentId ?? visibleAgents[0]?.id ?? null}
            repoPath={repoPath ?? ""}
            connectionId={connectionId ?? null}
            projectId={projectId ?? 0}
            onClose={() => setShowHistory(false)}
            onSessionLoaded={(key) => { setSelectedSessionKey(key); setShowHistory(false); }}
          />
        )}
      </div>

      {/* New Session dialog */}
      <Dialog open={showSpawnDialog} onOpenChange={setShowSpawnDialog}>
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
              <Select value={sessionType} onValueChange={(v) => { if (v) { setSessionType(v); setSelectedModel(""); } }}>
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
