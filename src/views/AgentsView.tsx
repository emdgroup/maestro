import { useState, useEffect } from "react";
import { AgentMonitor } from "@/components/execution/AgentMonitor";
import { usePendingAgentId, useNavigationActions } from "@/store/navigationStore";
import { useExecutionsWithTaskInfoQuery } from "@/services/execution.service";

interface AgentsViewProps {
  projectId?: number;
}

/**
 * AgentsView - Page-level orchestrator for the agent monitoring screen.
 * Owns the execution data query and passes props down to AgentMonitor.
 * Handles deep-link selection via pendingAgentId from navigationStore.
 */
export const AgentsView: React.FC<AgentsViewProps> = ({ projectId }) => {
  const { data: executions = [] } = useExecutionsWithTaskInfoQuery(projectId);
  const pendingAgentId = usePendingAgentId();
  const { clearPendingAgent } = useNavigationActions();
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);

  // Deep-link: pendingAgentId overrides selection on first mount
  useEffect(() => {
    if (pendingAgentId && executions.length > 0) {
      const match = executions.find((e) => String(e.task_id) === pendingAgentId);
      if (match) {
        setSelectedTaskId(match.task_id);
        clearPendingAgent();
      }
    } else if (selectedTaskId == null && executions.length > 0) {
      // Fallback: auto-select most recent Running execution
      const running = executions.find((e) => e.status === "running");
      if (running) setSelectedTaskId(running.task_id);
    }
  }, [executions, pendingAgentId, clearPendingAgent, selectedTaskId]);

  return (
    <AgentMonitor
      executions={executions}
      selectedTaskId={selectedTaskId}
      onSelect={setSelectedTaskId}
    />
  );
};
