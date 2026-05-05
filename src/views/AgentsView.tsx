import { useState, useEffect } from "react";
import { AgentMonitor } from "@/components/execution/AgentMonitor";
import { SessionHistoryPanel } from "@/components/execution/SessionHistoryPanel";
import { SpawnSessionDialog } from "@/components/execution/SpawnSessionDialog";
import { usePendingAgentId, useNavigationActions } from "@/store/navigationStore";
import {
  useActiveSessionsQuery,
  useSpawnInteractiveExecutionMutation,
  useAgentDiscoveryQuery,
  useCancelActiveSessionMutation,
} from "@/services/execution.service";
import { useWorktreesQuery } from "@/services/worktree.service";
import type { ActiveSessionInfo } from "@/types/bindings";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { Button } from "@/ui/button";
import { History, SearchIcon } from "lucide-react";

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

  const { data: worktrees = [] } = useWorktreesQuery(projectId, repoPath);
  const { data: discovery } = useAgentDiscoveryQuery(connectionId ?? null);
  const spawnMutation = useSpawnInteractiveExecutionMutation();
  const cancelMutation = useCancelActiveSessionMutation();

  const visibleAgents = discovery?.agents ?? [];
  const agentIcons: Record<string, string> = Object.fromEntries(
    visibleAgents.filter((a) => a.icon).map((a) => [a.id, a.icon]),
  );
  const lastAcpAgentId =
    [...sessions].reverse().find((s) => s.execution_mode === "acp")?.agent_id ?? null;

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
              <History className="size-3.5 mr-1" />
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
          onSpawn={() => setShowSpawnDialog(true)}
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
            onSessionLoaded={(key) => {
              setSelectedSessionKey(key);
              setShowHistory(false);
            }}
          />
        )}
      </div>

      <SpawnSessionDialog
        open={showSpawnDialog}
        onOpenChange={setShowSpawnDialog}
        projectId={projectId ?? 0}
        repoPath={repoPath ?? ""}
        connectionId={connectionId ?? null}
        worktrees={worktrees}
        onSuccess={setSelectedSessionKey}
      />
    </div>
  );
};
