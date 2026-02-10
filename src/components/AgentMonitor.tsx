import { useState } from "react";

interface AgentStatus {
  id: number;
  name: string;
  status: "Running" | "Idle" | "Error";
}

interface AgentMonitorProps {
  projectId?: number;
  agents?: AgentStatus[];
  activeAgentId?: number | null;
  onAgentSelect?: (agentId: number) => void;
}

export function AgentMonitor({
  agents = [],
  activeAgentId = null,
  onAgentSelect,
}: AgentMonitorProps) {
  const [terminalOutput] = useState<string>(
    "Terminal output will appear here...\n[INFO] System ready\n[INFO] Waiting for agent tasks..."
  );

  const getStatusColor = (status: string) => {
    switch (status) {
      case "Running":
        return "bg-warning animate-pulse";
      case "Idle":
        return "bg-muted";
      case "Error":
        return "bg-error";
      default:
        return "bg-muted";
    }
  };

  const getStatusTextColor = (status: string) => {
    switch (status) {
      case "Running":
        return "text-warning";
      case "Idle":
        return "text-muted-foreground";
      case "Error":
        return "text-error";
      default:
        return "text-muted-foreground";
    }
  };

  const handleAgentClick = (agentId: number) => {
    onAgentSelect?.(agentId);
  };

  return (
    <div className="flex gap-4 h-full bg-background p-4">
      {/* Left sidebar: Agent list */}
      <div className="w-64 flex flex-col border border-border rounded-lg bg-card shadow-sm overflow-hidden">
        {/* Sidebar header */}
        <div className="px-3 py-3 border-b border-border bg-muted/30 font-semibold text-sm">
          Agents
        </div>

        {/* Agent list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {agents.length === 0 ? (
            <div className="text-xs text-muted-foreground py-8 text-center">
              No agents available
            </div>
          ) : (
            agents.map((agent) => (
              <div
                key={agent.id}
                onClick={() => handleAgentClick(agent.id)}
                className={`
                  p-3 rounded-lg border border-border cursor-pointer
                  transition-all duration-200
                  ${
                    activeAgentId === agent.id
                      ? "bg-accent/10 border-ring shadow-md"
                      : "bg-card hover:shadow-md hover:border-ring"
                  }
                `}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${getStatusColor(
                      agent.status
                    )}`}
                  ></span>
                  <span className="font-medium text-sm text-foreground truncate">
                    {agent.name}
                  </span>
                </div>
                <div className={`text-xs font-medium ${getStatusTextColor(agent.status)}`}>
                  {agent.status}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right pane: Terminal output */}
      <div className="flex-1 flex flex-col border border-border rounded-lg bg-card shadow-sm overflow-hidden">
        {/* Terminal header */}
        <div className="px-4 py-3 border-b border-border bg-muted/30 font-semibold text-sm flex items-center justify-between">
          <span>Terminal Output</span>
          {activeAgentId && (
            <span className="text-xs text-muted-foreground ml-2">
              Agent #{activeAgentId}
            </span>
          )}
        </div>

        {/* Terminal output */}
        <div className="flex-1 overflow-y-auto p-4 font-mono text-sm bg-muted/5">
          {terminalOutput.split("\n").map((line, idx) => {
            let lineClassName = "text-foreground";

            if (line.includes("[INFO]")) {
              lineClassName = "text-accent";
            } else if (line.includes("[WARN]")) {
              lineClassName = "text-warning";
            } else if (line.includes("[ERROR]")) {
              lineClassName = "text-error";
            } else if (line.includes("[SUCCESS]")) {
              lineClassName = "text-success";
            }

            return (
              <div key={idx} className={`leading-relaxed ${lineClassName}`}>
                {line || "\u00A0"}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
