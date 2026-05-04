import { useState } from "react";
import { X, RotateCcw } from "lucide-react";
import { cn } from "@/lib";
import { Button } from "@/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { useSessionListQuery, useLoadAcpSessionMutation } from "@/services/execution.service";
import type { DiscoveredAgent } from "@/types/bindings";

interface SessionHistoryPanelProps {
  agents: DiscoveredAgent[];
  defaultAgentId: string | null;
  repoPath: string;
  connectionId: number | null;
  onClose: () => void;
  onSessionLoaded: (sessionKey: number) => void;
}

export function SessionHistoryPanel({
  agents,
  defaultAgentId,
  repoPath,
  connectionId,
  onClose,
  onSessionLoaded,
}: SessionHistoryPanelProps) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    defaultAgentId ?? agents[0]?.id ?? null,
  );

  const { data: sessions = [], isLoading, isError } = useSessionListQuery(
    selectedAgentId,
    repoPath,
    connectionId,
  );
  const loadMutation = useLoadAcpSessionMutation();

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-card border-l border-border">
      <div className="h-10 flex items-center justify-between px-4 border-b border-border shrink-0">
        <span className="text-sm font-medium">Session History</span>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>

      {agents.length > 1 && (
        <div className="px-4 py-2 border-b border-border shrink-0">
          <Select value={selectedAgentId ?? ""} onValueChange={(v) => v && setSelectedAgentId(v)}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="Select agent" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
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
      )}

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {isLoading && (
          <div className="text-xs text-muted-foreground py-8 text-center">Loading...</div>
        )}
        {isError && (
          <div className="text-xs text-destructive py-8 text-center">Failed to load history</div>
        )}
        {!isLoading && !isError && sessions.length === 0 && (
          <div className="text-xs text-muted-foreground py-8 text-center">No past sessions</div>
        )}
        {sessions.map((entry) => (
          <button
            key={entry.session_id}
            disabled={loadMutation.isPending}
            onClick={() => {
              if (!selectedAgentId) return;
              loadMutation.mutate(
                { agentId: selectedAgentId, sessionId: entry.session_id, cwd: repoPath, connectionId, sessionName: entry.title },
                { onSuccess: (sessionKey) => { onSessionLoaded(sessionKey); onClose(); } },
              );
            }}
            className={cn(
              "w-full text-left px-4 py-3 border-b border-border/50 hover:bg-muted/20 transition-colors",
              loadMutation.isPending && "opacity-50 cursor-not-allowed",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <RotateCcw className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5" />
                <span className="text-sm truncate">
                  {entry.title ?? entry.session_id}
                </span>
              </div>
              {entry.updated_at && (
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {new Date(entry.updated_at).toLocaleDateString()}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
