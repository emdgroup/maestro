import { useState, useEffect } from "react";
import { AgentMonitor, STATUS_FILTERS, STATUS_LABEL } from "@/components/execution/AgentMonitor";
import type { StatusFilter } from "@/components/execution/AgentMonitor";
import { usePendingAgentId, useNavigationActions } from "@/store/navigationStore";
import { useExecutionsWithTaskInfoQuery } from "@/services/execution.service";
import { Input } from "@/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";

interface AgentsViewProps {
  projectId?: number;
}

/**
 * AgentsView - Page-level orchestrator for the agent monitoring screen.
 * Owns the execution data query and filter state, passes props down to AgentMonitor.
 * Handles deep-link selection via pendingAgentId from navigationStore.
 */
export const AgentsView: React.FC<AgentsViewProps> = ({ projectId }) => {
  const { data: executions = [] } = useExecutionsWithTaskInfoQuery(projectId);
  const pendingAgentId = usePendingAgentId();
  const { clearPendingAgent } = useNavigationActions();
  const [selectedExecutionId, setSelectedExecutionId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");

  // Deep-link: pendingAgentId overrides selection on first mount (matches by task_id)
  useEffect(() => {
    if (pendingAgentId && executions.length > 0) {
      const match = executions.find((e) => String(e.task_id) === pendingAgentId);
      if (match) {
        setSelectedExecutionId(match.id);
        clearPendingAgent();
      }
    } else if (selectedExecutionId == null && executions.length > 0) {
      // Fallback: auto-select most recent Running execution
      const running = executions.find((e) => e.status === "running");
      if (running) setSelectedExecutionId(running.id);
    }
  }, [executions, pendingAgentId, clearPendingAgent, selectedExecutionId]);

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="h-12 border-b border-border bg-muted/30 flex items-center justify-between px-4 gap-2 shrink-0">
        <div className="flex items-center gap-2">
          <Input
            type="text"
            placeholder="Search agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-48 text-sm"
          />
          <ToggleGroup variant="outline" size="sm" defaultValue={["All"]}>
            {STATUS_FILTERS.map((f) => (
              <ToggleGroupItem
                key={f}
                value={f}
                pressed={statusFilter === f}
                onClick={() => setStatusFilter(f)}
                className="text-xs px-3"
              >
                {f === "All" ? "All" : (STATUS_LABEL[f] ?? f)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="flex items-center gap-2">
          {/* Right slot — Spawn Agent button added in plan 03 */}
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
        />
      </div>
    </div>
  );
};
