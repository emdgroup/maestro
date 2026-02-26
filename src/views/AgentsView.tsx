import { AgentMonitor } from "@/components/AgentMonitor";

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
  return (
    <AgentMonitor
      projectId={projectId}
      agents={agents}
      activeAgentId={activeAgentId}
      onAgentSelect={onAgentSelect}
    />
  );
};
