import { useState, useReducer, useEffect } from "react";
import { TerminalSquare, Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/ui/button";
import { formatDistanceStrict } from "date-fns";
import { useAcpActivity } from "./activity/useAcpActivity";
import { activityReducer } from "./activity/useAcpActivity";
import { useStructuredOutputQuery, executionQueryKeys } from "@/services/execution.service";
import { useSelectedProject } from "@/store/projectStore";
import { ActivityMessageItem } from "./activity/ActivityMessageItem";
import { ActivityToolCallCard } from "./activity/ActivityToolCallCard";
import { ActivityPlanPanel } from "./activity/ActivityPlanPanel";
import { AcpTerminalPanel } from "./activity/AcpTerminalPanel";
import { INITIAL_ACTIVITY_STATE } from "./activity/types";
import type { SessionUpdatePayload } from "./activity/types";
import type { ExecutionWithTask } from "@/types/bindings";

interface AgentActivityPanelProps {
  execution: ExecutionWithTask;
  isDead?: boolean;
}

export function AgentActivityPanel({ execution, isDead = false }: AgentActivityPanelProps) {
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const queryClient = useQueryClient();
  const selectedProject = useSelectedProject();
  const projectId = selectedProject?.id ?? null;

  // Live mode: subscribe to Tauri events
  const liveState = useAcpActivity(isDead ? null : execution.id);

  // Dead mode: load from DB and replay through the SAME activityReducer
  const { data: storedPayloads } = useStructuredOutputQuery(isDead ? execution.id : null);
  const [deadState, deadDispatch] = useReducer(activityReducer, INITIAL_ACTIVITY_STATE);

  // When stored payloads arrive, replay them through the reducer's load_from_db action
  useEffect(() => {
    if (!isDead || !storedPayloads || storedPayloads.length === 0) return;
    deadDispatch({
      type: "load_from_db",
      payloads: storedPayloads as unknown as SessionUpdatePayload[],
    });
  }, [isDead, storedPayloads]);

  const state = isDead ? deadState : liveState;

  // When a live session ends, invalidate the execution list query so sidebar refreshes status
  useEffect(() => {
    if (!isDead && state.sessionEnded && projectId != null) {
      queryClient.invalidateQueries({
        queryKey: executionQueryKeys.withTaskInfo(projectId),
      });
    }
  }, [isDead, state.sessionEnded, projectId, queryClient]);

  // Session ended banner
  const sessionEndedBanner =
    (isDead || state.sessionEnded) && execution.completed_at ? (
      <div className="h-8 border-b border-border bg-muted/30 flex items-center px-3 text-xs text-muted-foreground shrink-0">
        {execution.status === "failed"
          ? "Session ended (interrupted)"
          : execution.status === "cancelled"
            ? "Session cancelled"
            : "Session ended"}
        {" · "}
        {new Date(execution.completed_at).toLocaleString()}
        {" · "}
        {formatDistanceStrict(
          new Date(execution.started_at),
          new Date(execution.completed_at),
        )}
      </div>
    ) : null;

  // Initializing state (spinner + "Starting agent..." until first event)
  if (state.isInitializing && !isDead) {
    return (
      <div className="flex-1 flex flex-col">
        {/* Header bar */}
        <div className="h-8 border-b border-border bg-muted/30 flex items-center justify-between px-3 shrink-0">
          <span className="text-xs text-muted-foreground">
            {execution.agent_id ?? "ACP Agent"}
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            Starting agent...
          </div>
        </div>
      </div>
    );
  }

  // Dead mode loading state (waiting for DB query to resolve)
  if (isDead && state.isInitializing) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Loading session data...
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header bar with session info + terminal toggle */}
      <div className="h-8 border-b border-border bg-muted/30 flex items-center justify-between px-3 shrink-0">
        <span className="text-xs text-muted-foreground">
          {execution.agent_id ?? "ACP Agent"}
        </span>
        {/* Terminal toggle — only for live sessions (dead ACP sessions have no persisted terminal output) */}
        {!isDead && (
          <Button
            variant={isTerminalOpen ? "secondary" : "ghost"}
            size="sm"
            className="h-6 text-[10px] px-2 gap-1"
            onClick={() => setIsTerminalOpen((v) => !v)}
          >
            <TerminalSquare className="w-3 h-3" />
            Terminal
          </Button>
        )}
      </div>

      {/* Session ended banner */}
      {sessionEndedBanner}

      {/* Activity content area */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Scrollable activity + sticky plan */}
        <div className="flex-1 flex flex-col overflow-y-auto relative">
          {/* Sticky plan panel (sticky top, compact checklist, hides when no plan) */}
          {state.plan && (
            <div className="sticky top-0 z-10 bg-card border-b border-border">
              <ActivityPlanPanel entries={state.plan} />
            </div>
          )}

          {/* Activity items */}
          <div className="flex-1 p-3 space-y-3">
            {state.items.map((item) => {
              if (item.type === "message") {
                return <ActivityMessageItem key={item.item.id} message={item.item} />;
              }
              if (item.type === "toolCall") {
                return (
                  <ActivityToolCallCard key={item.item.toolCallId} toolCall={item.item} />
                );
              }
              return null;
            })}
          </div>
        </div>

        {/* Terminal bottom panel (VS Code-style slide-in) */}
        <AnimatePresence>
          {isTerminalOpen && !isDead && (
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: 280 }}
              exit={{ height: 0 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
              className="border-t border-border overflow-hidden shrink-0"
            >
              <AcpTerminalPanel logId={execution.id} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
