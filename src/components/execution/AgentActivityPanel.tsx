import { useState, useReducer, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, ChevronDown } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import type { ComposeBarHandle } from "./activity/ComposeBar";
import { SessionToolbar } from "./activity/SessionToolbar";
import type { PermissionMode, ModelOption } from "./activity/SessionToolbar";
import { PermissionPrompt, isAllowKind } from "./activity/PermissionPrompt";
import { PermissionDeniedCard } from "./activity/PermissionDeniedCard";
import { ElicitationPrompt, parseElicitationFields } from "./activity/ElicitationPrompt";
import { ActivityElicitationSummary } from "./activity/ActivityElicitationSummary";
import { INITIAL_ACTIVITY_STATE } from "./activity/types";
import type { SessionUpdatePayload, UserMessageItem, PermissionDeniedItem, ElicitationSummaryItem, ToolCallItem, ActivityItem, UsageState, AvailableCommand } from "./activity/types";
import type { ExecutionWithTask, AcpPromptCapabilities, JsonValue } from "@/types/bindings";
import { api } from "@/lib/tauri-utils";

interface AgentActivityPanelProps {
  execution: ExecutionWithTask;
  isDead?: boolean;
  isSelected?: boolean;
}

function isRejectOption(payload: Record<string, unknown>, optionId: string): boolean {
  const options = payload.options as Array<{ optionId: string; kind: string }> | undefined;
  const opt = options?.find((o) => o.optionId === optionId);
  return !opt || !isAllowKind(opt.kind);
}

function getOptionName(payload: Record<string, unknown>, optionId: string | null): string | undefined {
  if (!optionId) return undefined;
  const options = payload.options as Array<{ optionId: string; name: string }> | undefined;
  return options?.find((o) => o.optionId === optionId)?.name;
}

export function AgentActivityPanel({ execution, isDead = false, isSelected = false }: AgentActivityPanelProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatContentRef = useRef<HTMLDivElement>(null);
  const [showScrollFab, setShowScrollFab] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const atBottomRef = useRef(true);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState<string>("");
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [usageState, setUsageState] = useState<UsageState | null>(null);
  const [availableCommands, setAvailableCommands] = useState<AvailableCommand[]>([]);
  const [promptCapabilities, setPromptCapabilities] = useState<AcpPromptCapabilities | null>(null);
  const composeBarRef = useRef<ComposeBarHandle>(null);
  const userMsgCounterRef = useRef(0);
  const queryClient = useQueryClient();
  const selectedProject = useSelectedProject();
  const projectId = selectedProject?.id ?? null;

  const [liveState, liveDispatch] = useAcpActivity(isDead ? null : execution.id);

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

  const agentItemsCountRef = useRef(0);
  useLayoutEffect(() => { agentItemsCountRef.current = state.items.length; });

  const [liveUserMessages, setLiveUserMessages] = useState<Array<{ item: UserMessageItem; insertAt: number }>>([]);
  const [liveElicitationSummaries, setLiveElicitationSummaries] = useState<Array<{ item: ElicitationSummaryItem; insertAt: number }>>([]);

  const [pendingPermission, setPendingPermission] = useState<{
    requestId: string;
    payload: Record<string, unknown>;
  } | null>(null);
  const [liveDeniedPermissions, setLiveDeniedPermissions] = useState<Array<{ item: PermissionDeniedItem; insertAt: number }>>([]);

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

  // Fetch cached capabilities on mount (handles race where capabilities event fires before listener registers).
  useEffect(() => {
    if (isDead) return;
    api.getAcpCapabilities(execution.id).then((caps) => {
      if (caps) setPromptCapabilities(caps);
    }).catch(() => {});
  }, [isDead, execution.id]);

  useEffect(() => {
    if (isDead) return;
    const unlisten = listen<AcpPromptCapabilities>(
      `acp://session-capabilities/${execution.id}`,
      (event) => {
        setPromptCapabilities(event.payload);
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, [isDead, execution.id]);

  // Fetch cached models on mount (handles race where SpawnOk fires before listener registers).
  useEffect(() => {
    if (isDead) return;
    api.getAcpModels(execution.id).then((modelState) => {
      if (modelState) {
        setModels(modelState.available_models.map((m) => ({ id: m.model_id, label: m.name })));
        setModelId(modelState.current_model_id);
        setModelsLoaded(true);
      }
    }).catch(() => {});
  }, [isDead, execution.id]);

  useEffect(() => {
    if (isDead) return;
    const unlisten = listen<{ current_model_id: string; available_models: Array<{ model_id: string; name: string }> }>(
      `acp://session-models/${execution.id}`,
      (event) => {
        const { current_model_id, available_models } = event.payload;
        setModels(available_models.map((m) => ({ id: m.model_id, label: m.name })));
        setModelId(current_model_id);
        setModelsLoaded(true);
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, [isDead, execution.id]);

  useEffect(() => {
    if (isDead) return;
    const unlisten = listen<string>(`acp://model-changed/${execution.id}`, (event) => {
      setModelId(event.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [isDead, execution.id]);

  useEffect(() => {
    if (isDead) return;
    type SessionUpdatePayloadRaw = {
      sessionUpdate?: string;
      used?: number;
      size?: number;
      cost?: { amount: number; currency: string };
      availableCommands?: AvailableCommand[];
    };
    const unlisten = listen<SessionUpdatePayloadRaw>(
      `acp://session-update/${execution.id}`,
      (event) => {
        const p = event.payload;
        if (p.sessionUpdate === "usage_update") {
          if (typeof p.used === "number" && typeof p.size === "number") {
            setUsageState((prev) => ({
              used: p.used!,
              size: p.size!,
              cost: p.cost ?? prev?.cost ?? null,
            }));
          }
        } else if (p.sessionUpdate === "available_commands_update") {
          if (Array.isArray(p.availableCommands)) {
            setAvailableCommands(p.availableCommands);
          }
        }
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, [isDead, execution.id]);

  const handleModelChange = useCallback(async (id: string) => {
    const prev = modelId;
    setModelId(id);
    try { await api.setAcpModel(execution.id, id); } catch { setModelId(prev); }
  }, [execution.id, modelId]);

  const handleElicitationSubmit = useCallback(
    async (requestId: string, values: Record<string, unknown>) => {
      try {
        await api.respondAcpElicitation(execution.id, requestId, { action: "accept", content: values } as never);
      } catch { /* best-effort */ }
      if (pendingElicitation) {
        const insertAt = agentItemsCountRef.current;
        setLiveElicitationSummaries((prev) => [...prev, { item: makeElicitationSummary(requestId, pendingElicitation.payload, formatElicitationAnswer(values)), insertAt }]);
      }
      setPendingElicitation(null);
    },
    [execution.id, pendingElicitation],
  );

  const handleElicitationDecline = useCallback(
    async (requestId: string) => {
      try {
        await api.respondAcpElicitation(execution.id, requestId, { action: "decline" });
      } catch { /* best-effort */ }
      if (pendingElicitation) {
        const insertAt = agentItemsCountRef.current;
        setLiveElicitationSummaries((prev) => [...prev, { item: makeElicitationSummary(requestId, pendingElicitation.payload, "Declined"), insertAt }]);
      }
      setPendingElicitation(null);
    },
    [execution.id, pendingElicitation],
  );

  const handlePermissionRespond = useCallback(
    async (requestId: string, optionId: string | null) => {
      try {
        await api.respondAcpPermission(execution.id, requestId, optionId);
      } catch {
        // best-effort
      }
      const isRejection = !optionId || isRejectOption(pendingPermission?.payload ?? {}, optionId);
      if (isRejection && pendingPermission) {
        const denied: PermissionDeniedItem = {
          id: `denied-${requestId}`,
          payload: pendingPermission.payload,
          optionName: getOptionName(pendingPermission.payload, optionId),
        };
        const insertAt = agentItemsCountRef.current;
        setLiveDeniedPermissions((prev) => [...prev, { item: denied, insertAt }]);
      }
      setPendingPermission(null);
    },
    [execution.id, pendingPermission],
  );

  const handleSend = useCallback(
    async (content: string, contentBlocks?: JsonValue) => {
      if (isDead || isProcessing) return;
      liveDispatch({ type: "finalize_streaming" });
      const userMsg: UserMessageItem = {
        id: `user-${++userMsgCounterRef.current}`,
        content: contentBlocks ? JSON.stringify(contentBlocks) : content,
        sentAt: Date.now(),
      };
      const insertAt = agentItemsCountRef.current;
      setLiveUserMessages((prev) => [...prev, { item: userMsg, insertAt }]);
      setIsProcessing(true);
      try {
        if (contentBlocks) {
          await api.sendAcpPromptStructured(execution.id, contentBlocks);
        } else {
          await api.sendAcpPrompt(execution.id, content);
        }
      } catch {
        setIsProcessing(false);
      }
    },
    [isDead, isProcessing, execution.id, liveDispatch],
  );

  const handleCancel = useCallback(async () => {
    try {
      await api.cancelAcpSession(execution.id);
    } catch {
      // best-effort
    }
    setIsProcessing(false);
  }, [execution.id]);

  // Focus compose bar when this panel becomes selected or finishes initializing
  useEffect(() => {
    if (!isSelected || isDead || state.isInitializing || !modelsLoaded || pendingPermission || pendingElicitation) return;
    const timer = setTimeout(() => composeBarRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [isSelected, isDead, state.isInitializing, modelsLoaded, pendingPermission, pendingElicitation]);

  // Focus compose bar when app window regains focus
  useEffect(() => {
    if (!isSelected || isDead || state.sessionEnded) return;
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused || state.isInitializing || !modelsLoaded || pendingPermission || pendingElicitation) return;
      requestAnimationFrame(() => composeBarRef.current?.focus());
    });
    return () => { unlisten.then((fn) => fn()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSelected, isDead, state.sessionEnded, state.isInitializing, modelsLoaded, pendingPermission, pendingElicitation]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY < 0) {
      const el = chatScrollRef.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) return;
      atBottomRef.current = false;
      setShowScrollFab(true);
    }
  }, []);

  const handleChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom) {
      atBottomRef.current = true;
      setShowScrollFab(false);
      setHasUnread(false);
    }
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior });
    atBottomRef.current = true;
    setShowScrollFab(false);
    setHasUnread(false);
  }, []);

  const displayItems = useMemo(
    () => isDead ? state.items : mergeLiveItems(state.items, liveUserMessages, liveDeniedPermissions, liveElicitationSummaries),
    [isDead, state.items, liveUserMessages, liveDeniedPermissions, liveElicitationSummaries],
  );

  const groupedItems = useMemo(() => groupToolCalls(displayItems), [displayItems]);

  // Refs are null while the spinner renders; register observer only after init clears.
  useEffect(() => {
    if (state.isInitializing || !modelsLoaded || isDead) return;
    const scrollEl = chatScrollRef.current;
    const contentEl = chatContentRef.current;
    if (!scrollEl || !contentEl) return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      } else {
        setHasUnread(true);
      }
    });
    ro.observe(contentEl);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.isInitializing, modelsLoaded, isDead]);

  // Dead session: scroll to bottom once data finishes loading
  useEffect(() => {
    if (!isDead || state.isInitializing) return;
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    atBottomRef.current = true;
  }, [isDead, state.isInitializing]);

  // 2s: mark session as responsive.
  useEffect(() => {
    if (isDead || !state.isInitializing) return;
    const timer = setTimeout(() => liveDispatch({ type: "set_initialized" }), 2000);
    return () => clearTimeout(timer);
  }, [isDead, state.isInitializing, liveDispatch]);

  // 10s: safety valve for agents without model support — unblock UI if models never arrive.
  useEffect(() => {
    if (isDead || modelsLoaded) return;
    const timer = setTimeout(() => setModelsLoaded(true), 10000);
    return () => clearTimeout(timer);
  }, [isDead, modelsLoaded]);

  const contextWarning = useMemo(() => {
    if (!usageState || usageState.size === 0) return null;
    const ratio = usageState.used / usageState.size;
    if (ratio < 0.8) return null;
    const pct = Math.round(ratio * 100);
    const exceeded = ratio >= 1;
    return (
      <div className={`px-3.5 py-2 text-xs border-t border-border/30 ${exceeded ? "text-destructive" : "text-amber-500"}`}>
        {exceeded ? "Context exhausted" : `Context window is ${pct}% full`}
      </div>
    );
  }, [usageState]);

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

  if (!isDead && (state.isInitializing || !modelsLoaded)) {
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
          {contextWarning}
          <ComposeBar
            ref={composeBarRef}
            onSend={handleSend}
            onCancel={handleCancel}
            isProcessing={isProcessing}
            commands={availableCommands}
            embeddedContext={promptCapabilities?.embedded_context ?? false}
            logId={execution?.id ?? null}
            projectPath={selectedProject?.path ?? null}
          />
          <SessionToolbar
            models={models}
            modelId={modelId}
            permissionMode={permissionMode}
            onModelChange={handleModelChange}
            onPermissionModeChange={setPermissionMode}
            usageState={usageState}
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
            className="absolute inset-0 overflow-y-auto overflow-x-hidden flex flex-col custom-scrollbar"
            ref={chatScrollRef}
            onScroll={handleChatScroll}
            onWheel={handleWheel}
          >
            {state.plan && (
              <div className="sticky top-0 z-10 bg-card border-b border-border">
                <ActivityPlanPanel entries={state.plan} />
              </div>
            )}

            <div ref={chatContentRef} className="flex-1 p-3 space-y-3">
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
                if (item.type === "elicitationSummary") {
                  return <ActivityElicitationSummary key={item.item.id} item={item.item} />;
                }
                return null;
              })}
            </div>
          </div>

          <AnimatePresence>
            {showScrollFab && (
              <motion.button
                key="scroll-fab"
                type="button"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 0.15 }}
                onClick={() => scrollToBottom()}
                className={`absolute bottom-4 right-4 z-20 w-8 h-8 rounded-full border shadow-md flex items-center justify-center transition-colors ${hasUnread ? "bg-accent border-accent hover:bg-accent/80" : "bg-card border-border hover:bg-muted/80"}`}
                aria-label="Scroll to bottom"
              >
                <ChevronDown className={`w-4 h-4 ${hasUnread ? "text-accent-foreground" : "text-muted-foreground"}`} />
              </motion.button>
            )}
          </AnimatePresence>
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

// Interleave live user/permission/elicitation items into agent items based on
// insertion index — i.e., where in agent items each was recorded at send time.
function mergeLiveItems(
  agentItems: ActivityItem[],
  userMessages: Array<{ item: UserMessageItem; insertAt: number }>,
  deniedPermissions: Array<{ item: PermissionDeniedItem; insertAt: number }>,
  elicitationSummaries: Array<{ item: ElicitationSummaryItem; insertAt: number }>,
): ActivityItem[] {
  if (userMessages.length === 0 && deniedPermissions.length === 0 && elicitationSummaries.length === 0) return agentItems;

  type Slot = { insertAt: number; ai: ActivityItem };
  const slots: Slot[] = [
    ...userMessages.map(({ item, insertAt }) => ({ insertAt, ai: { type: "userMessage" as const, item } })),
    ...deniedPermissions.map(({ item, insertAt }) => ({ insertAt, ai: { type: "permissionDenied" as const, item } })),
    ...elicitationSummaries.map(({ item, insertAt }) => ({ insertAt, ai: { type: "elicitationSummary" as const, item } })),
  ].sort((a, b) => a.insertAt - b.insertAt);

  const result: ActivityItem[] = [];
  let si = 0;
  for (let i = 0; i <= agentItems.length; i++) {
    while (si < slots.length && slots[si].insertAt <= i) {
      result.push(slots[si].ai);
      si++;
    }
    if (i < agentItems.length) result.push(agentItems[i]);
  }
  return result;
}

function makeElicitationSummary(requestId: string, payload: Record<string, unknown>, answer: string): ElicitationSummaryItem {
  return { id: `elicit-${requestId}`, question: String(payload.message ?? "Elicitation"), answer };
}

function formatElicitationAnswer(values: Record<string, unknown>): string {
  const parts = Object.values(values).filter((v) => v !== null && v !== undefined && v !== "");
  if (parts.length === 0) return "Submitted";
  return parts.map((v) => (Array.isArray(v) ? v.join(", ") : String(v))).join("; ");
}
