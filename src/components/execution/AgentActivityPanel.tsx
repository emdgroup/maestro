import { useState, useReducer, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader2, ChevronDown } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { formatDistanceStrict } from "date-fns";
import { useAcpActivity, activityReducer } from "./activity/useAcpActivity";
import { useStructuredOutputQuery, executionQueryKeys } from "@/services/execution.service";
import { useSelectedProject } from "@/store/projectStore";
import { ActivityMessageItem } from "./activity/ActivityMessageItem";
import { ActivityUserMessage } from "./activity/ActivityUserMessage";
import { ActivityThinkingBlock } from "./activity/ActivityThinkingBlock";
import { ActivityToolCallGroup } from "./activity/ActivityToolCallGroup";
import { ActivityPlanPanel } from "./activity/ActivityPlanPanel";
import { ComposeBar } from "./activity/ComposeBar";
import { SessionToolbar } from "./activity/SessionToolbar";
import type { PermissionMode, ClaudeModelId } from "./activity/SessionToolbar";
import { PermissionPrompt } from "./activity/PermissionPrompt";
import { PermissionDeniedCard } from "./activity/PermissionDeniedCard";
import { ElicitationPrompt, parseElicitationFields } from "./activity/ElicitationPrompt";
import { INITIAL_ACTIVITY_STATE } from "./activity/types";
import type { SessionUpdatePayload, UserMessageItem, PermissionDeniedItem, ToolCallItem, ActivityItem } from "./activity/types";
import type { ExecutionWithTask } from "@/types/bindings";
import { api } from "@/lib/tauri-utils";

interface AgentActivityPanelProps {
  execution: ExecutionWithTask;
  isDead?: boolean;
}

let userMsgCounter = 0;

export function AgentActivityPanel({ execution, isDead = false }: AgentActivityPanelProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const [showScrollFab, setShowScrollFab] = useState(false);
  const atBottomRef = useRef(true);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const [modelId, setModelId] = useState<ClaudeModelId>("claude-sonnet-4-6");
  const queryClient = useQueryClient();
  const selectedProject = useSelectedProject();
  const projectId = selectedProject?.id ?? null;

  const liveState = useAcpActivity(isDead ? null : execution.id);

  const { data: storedPayloads } = useStructuredOutputQuery(isDead ? execution.id : null);
  const [deadState, deadDispatch] = useReducer(activityReducer, INITIAL_ACTIVITY_STATE);

  useEffect(() => {
    if (!isDead || !storedPayloads || storedPayloads.length === 0) return;
    deadDispatch({
      type: "load_from_db",
      payloads: storedPayloads as unknown as SessionUpdatePayload[],
    });
  }, [isDead, storedPayloads]);

  const state = isDead ? deadState : liveState;

  useEffect(() => {
    if (isProcessing && state.items.length > 0) {
      const last = state.items[state.items.length - 1];
      if (last.type === "message" || last.type === "toolCall" || last.type === "thinking") {
        setIsProcessing(false);
      }
    }
  }, [isProcessing, state.items]);

  useEffect(() => {
    if (!isDead && state.sessionEnded) {
      setIsProcessing(false);
      if (projectId != null) {
        queryClient.invalidateQueries({
          queryKey: executionQueryKeys.withTaskInfo(projectId),
        });
      }
    }
  }, [isDead, state.sessionEnded, projectId, queryClient]);

  const [liveUserMessages, setLiveUserMessages] = useState<UserMessageItem[]>([]);

  const [pendingPermission, setPendingPermission] = useState<{
    requestId: string;
    payload: Record<string, unknown>;
  } | null>(null);
  const [liveDeniedPermissions, setLiveDeniedPermissions] = useState<PermissionDeniedItem[]>([]);

  useEffect(() => {
    if (isDead) return;
    const unlisten = listen<{ request_id: string; payload: Record<string, unknown> }>(
      `acp://permission-request/${execution.id}`,
      (event) => {
        setPendingPermission({
          requestId: event.payload.request_id,
          payload: event.payload.payload,
        });
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [isDead, execution.id]);

  const [pendingElicitation, setPendingElicitation] = useState<{
    requestId: string;
    payload: Record<string, unknown>;
  } | null>(null);

  useEffect(() => {
    if (isDead) return;
    const unlisten = listen<{ request_id: string; payload: Record<string, unknown> }>(
      `acp://elicitation-request/${execution.id}`,
      (event) => {
        setPendingElicitation({ requestId: event.payload.request_id, payload: event.payload.payload });
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, [isDead, execution.id]);

  const handleElicitationSubmit = useCallback(
    async (requestId: string, values: Record<string, unknown>) => {
      try {
        await api.respondAcpElicitation(execution.id, requestId, { action: "accept", content: values } as never);
      } catch { /* best-effort */ }
      setPendingElicitation(null);
    },
    [execution.id],
  );

  const handleElicitationDecline = useCallback(
    async (requestId: string) => {
      try {
        await api.respondAcpElicitation(execution.id, requestId, { action: "decline" });
      } catch { /* best-effort */ }
      setPendingElicitation(null);
    },
    [execution.id],
  );

  const handlePermissionRespond = useCallback(
    async (requestId: string, allowed: boolean) => {
      try {
        await api.respondAcpPermission(execution.id, requestId, allowed);
      } catch {
        // best-effort
      }
      if (!allowed && pendingPermission) {
        const denied: PermissionDeniedItem = {
          id: `denied-${requestId}`,
          payload: pendingPermission.payload,
        };
        setLiveDeniedPermissions((prev) => [...prev, denied]);
      }
      setPendingPermission(null);
    },
    [execution.id, pendingPermission],
  );

  const handleSend = useCallback(
    async (content: string) => {
      if (isDead || isProcessing) return;
      const userMsg: UserMessageItem = {
        id: `user-${++userMsgCounter}`,
        content,
        sentAt: Date.now(),
      };
      setLiveUserMessages((prev) => [...prev, userMsg]);
      setIsProcessing(true);
      try {
        await api.sendAcpPrompt(execution.id, content);
      } catch {
        setIsProcessing(false);
      }
    },
    [isDead, isProcessing, execution.id],
  );

  const handleCancel = useCallback(async () => {
    try {
      await api.cancelAcpSession(execution.id);
    } catch {
      // best-effort
    }
    setIsProcessing(false);
  }, [execution.id]);

  const handleChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = atBottom;
    setShowScrollFab((prev) => {
      const next = !atBottom;
      return prev === next ? prev : next;
    });
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior });
  }, []);

  const displayItems = useMemo(
    () => isDead ? state.items : mergeLiveItems(state.items, liveUserMessages, liveDeniedPermissions),
    [isDead, state.items, liveUserMessages, liveDeniedPermissions],
  );

  const groupedItems = useMemo(() => groupToolCalls(displayItems), [displayItems]);

  useEffect(() => {
    if (atBottomRef.current) {
      scrollToBottom("instant");
    }
  }, [groupedItems, scrollToBottom]);

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

  if (state.isInitializing && !isDead) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Starting agent...
        </div>
      </div>
    );
  }

  if (isDead && state.isInitializing) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Loading session data...
      </div>
    );
  }

  const isSessionDead = isDead || state.sessionEnded;
  const elicitationContent = pendingElicitation
    ? { requestId: pendingElicitation.requestId, ...parseElicitationFields(pendingElicitation.payload) }
    : null;

  let bottomBar: React.ReactNode = null;
  if (!isSessionDead) {
    if (elicitationContent) {
      bottomBar = (
        <ElicitationPrompt
          requestId={elicitationContent.requestId}
          message={elicitationContent.message}
          fields={elicitationContent.fields}
          onSubmit={handleElicitationSubmit}
          onDecline={handleElicitationDecline}
        />
      );
    } else if (pendingPermission) {
      bottomBar = (
        <PermissionPrompt
          requestId={pendingPermission.requestId}
          payload={pendingPermission.payload}
          onRespond={handlePermissionRespond}
        />
      );
    } else {
      bottomBar = (
        <>
          <ComposeBar
            onSend={handleSend}
            onCancel={handleCancel}
            isProcessing={isProcessing}
          />
          <SessionToolbar
            modelId={modelId}
            permissionMode={permissionMode}
            onModelChange={setModelId}
            onPermissionModeChange={setPermissionMode}
          />
        </>
      );
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {sessionEndedBanner}

      {/* Activity content area */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Scroll area with FAB overlay */}
        <div className="flex-1 relative min-h-0 overflow-hidden">
          <div
            className="absolute inset-0 overflow-y-auto flex flex-col"
            ref={chatScrollRef}
            onScroll={handleChatScroll}
          >
            {state.plan && (
              <div className="sticky top-0 z-10 bg-card border-b border-border">
                <ActivityPlanPanel entries={state.plan} />
              </div>
            )}

            <div className="flex-1 p-3 space-y-3">
              {groupedItems.map((gi, idx) => {
                if (gi.type === "toolGroup") {
                  return (
                    <ActivityToolCallGroup
                      key={`tg-${idx}-${gi.items[0].toolCallId}`}
                      items={gi.items}
                    />
                  );
                }
                const item = gi.item;
                if (item.type === "message") {
                  return <ActivityMessageItem key={item.item.id} message={item.item} />;
                }
                if (item.type === "thinking") {
                  return <ActivityThinkingBlock key={item.item.id} thinking={item.item} />;
                }
                if (item.type === "userMessage") {
                  return <ActivityUserMessage key={item.item.id} message={item.item} />;
                }
                if (item.type === "permissionDenied") {
                  return <PermissionDeniedCard key={item.item.id} item={item.item} />;
                }
                return null;
              })}
            </div>
          </div>

          {showScrollFab && (
            <button
              type="button"
              onClick={() => scrollToBottom()}
              className="absolute bottom-4 right-4 z-20 w-8 h-8 rounded-full bg-card border border-border shadow-md flex items-center justify-center hover:bg-muted/80 transition-colors"
              aria-label="Scroll to bottom"
            >
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            </button>
          )}
        </div>

        {bottomBar}
      </div>
    </div>
  );
}

type GroupedDisplayItem =
  | { type: "solo"; item: ActivityItem }
  | { type: "toolGroup"; items: ToolCallItem[] };

function groupToolCalls(items: ActivityItem[]): GroupedDisplayItem[] {
  const result: GroupedDisplayItem[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (item.type === "toolCall") {
      const group: ToolCallItem[] = [item.item];
      while (i + 1 < items.length && items[i + 1].type === "toolCall") {
        i++;
        group.push((items[i] as { type: "toolCall"; item: ToolCallItem }).item);
      }
      result.push({ type: "toolGroup", items: group });
    } else {
      result.push({ type: "solo", item });
    }
    i++;
  }
  return result;
}

// Append-order heuristic: no timestamps on agent items, so append user messages last.
function mergeLiveItems(
  items: ReturnType<typeof useAcpActivity>["items"],
  userMessages: UserMessageItem[],
  deniedPermissions: PermissionDeniedItem[],
) {
  if (userMessages.length === 0 && deniedPermissions.length === 0) return items;
  const result = [...items];
  for (const um of userMessages) {
    result.push({ type: "userMessage", item: um });
  }
  for (const dp of deniedPermissions) {
    result.push({ type: "permissionDenied", item: dp });
  }
  return result;
}
