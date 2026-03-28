import { useEffect } from "react";
import { AgentMonitor } from "@/components/execution/AgentMonitor";
import { usePendingAgentId, useNavigationActions } from "@/store/navigationStore";

interface AgentStatus {
  id: number;
  name: string;
  status: "Running" | "Idle" | "Error";
}

interface AgentsViewProps {
  projectId?: number;
  agents?: AgentStatus[];
  activeAgentId?: number | null;
  onAgentSelect?: (agentId: number) => void;
}

/**
 * AgentsView - Page-level orchestrator for the agent monitoring screen
 * Displays active agents and their execution status with real-time terminal output
 */
export const AgentsView: React.FC<AgentsViewProps> = ({
  projectId,
  agents = [],
  activeAgentId = null,
  onAgentSelect,
}) => {
  const pendingAgentId = usePendingAgentId();
  const { clearPendingAgent } = useNavigationActions();

  // Override activeAgentId prop with pendingAgentId when set by navigate()
  const effectiveAgentId = pendingAgentId ? Number(pendingAgentId) : activeAgentId;

  useEffect(() => {
    if (pendingAgentId) {
      clearPendingAgent();
    }
  }, [pendingAgentId, clearPendingAgent]);

  return (
    <AgentMonitor
      projectId={projectId}
      agents={agents}
      activeAgentId={effectiveAgentId}
      onAgentSelect={onAgentSelect}
    />
  );
};
