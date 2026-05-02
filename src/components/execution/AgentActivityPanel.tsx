import { useState, useReducer, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { formatDistanceStrict } from "date-fns";
import { useAcpActivity, activityReducer } from "./activity/useAcpActivity";
import { useStructuredOutputQuery, executionQueryKeys } from "@/services/execution.service";
import { useSelectedProject } from "@/store/projectStore";
import { ActivityMessageItem } from "./activity/ActivityMessageItem";
import { ActivityUserMessage, parseUserContent } from "./activity/ActivityUserMessage";
import { ActivityThinkingBlock } from "./activity/ActivityThinkingBlock";
import { ActivityToolCallGroup } from "./activity/ActivityToolCallGroup";
import { ActivityPlanPanel } from "./activity/ActivityPlanPanel";
import { ComposeBar } from "./activity/ComposeBar";
import type { ComposeBarHandle, PermissionMode, ModelOption } from "./activity/ComposeBar";
import { PermissionPrompt, isAllowKind, isPlanPermission } from "./activity/PermissionPrompt";
import { PermissionResponseCard } from "./activity/PermissionResponseCard";
import { ElicitationPrompt, parseElicitationFields } from "./activity/ElicitationPrompt";
import { ActivityElicitationSummary } from "./activity/ActivityElicitationSummary";
import { INITIAL_ACTIVITY_STATE } from "./activity/types";
import type { SessionUpdatePayload, UserMessageItem, PermissionResponseItem, ElicitationSummaryItem, ToolCallItem, ActivityItem, UsageState, AvailableCommand } from "./activity/types";
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
  const [actualModelId, setActualModelId] = useState<string | null>(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [usageState, setUsageState] = useState<UsageState | null>(null);
  const [availableCommands, setAvailableCommands] = useState<AvailableCommand[]>([]);
  const [promptCapabilities, setPromptCapabilities] = useState<AcpPromptCapabilities | null>(null);
  const composeBarRef = useRef<ComposeBarHandle>(null);
  const userMsgCounterRef = useRef(0);
  const lastUserMsgRef = useRef<HTMLDivElement>(null);
  const agentResponseStartRef = useRef<HTMLDivElement>(null);
  const [showStickyUserMsg, setShowStickyUserMsg] = useState(false);
  const [agentResponseAbove, setAgentResponseAbove] = useState(false);
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
    if (isDead) return;
    const unlisten = listen<string>(`acp://turn-ended/${execution.id}`, () => {
      setIsProcessing(false);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [isDead, execution.id]);

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
  const [livePermissionResponses, setLivePermissionResponses] = useState<Array<{ item: PermissionResponseItem; insertAt: number }>>([]);

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
        setActualModelId(modelState.current_model_id);
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
        setActualModelId(current_model_id);
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
    type ConfigOption = {
      category?: string;
      type?: string;
      currentValue?: string;
    };
    type SessionUpdatePayloadRaw = {
      sessionUpdate?: string;
      used?: number;
      size?: number;
      cost?: { amount: number; currency: string };
      availableCommands?: AvailableCommand[];
      configOptions?: ConfigOption[];
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
        } else if (p.sessionUpdate === "config_option_update") {
          const modelConfig = p.configOptions?.find(
            (opt) => opt.category === "model" && opt.type === "select",
          );
          if (modelConfig?.currentValue) {
            setActualModelId(modelConfig.currentValue);
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
      if (pendingPermission) {
        const isRejection = !optionId || isRejectOption(pendingPermission.payload, optionId);
        const responseItem: PermissionResponseItem = {
          id: `perm-${requestId}`,
          optionName: getOptionName(pendingPermission.payload, optionId) ?? (isRejection ? "Permission denied" : "Allowed"),
          isRejection,
        };
        const insertAt = agentItemsCountRef.current;
        setLivePermissionResponses((prev) => [...prev, { item: responseItem, insertAt }]);
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
    () => isDead ? state.items : mergeLiveItems(state.items, liveUserMessages, livePermissionResponses, liveElicitationSummaries),
    [isDead, state.items, liveUserMessages, livePermissionResponses, liveElicitationSummaries],
  );

  const groupedItems = useMemo(() => groupToolCalls(displayItems), [displayItems]);

  const { lastUserMessage, agentResponseStartIdx } = useMemo(() => {
    let lastUserMessage: UserMessageItem | null = null;
    let lastUserMessageIdx = -1;
    for (let i = groupedItems.length - 1; i >= 0; i--) {
      const gi = groupedItems[i];
      if (gi.type === "solo" && gi.item.type === "userMessage") {
        lastUserMessage = gi.item.item;
        lastUserMessageIdx = i;
        break;
      }
    }
    const agentResponseStartIdx = lastUserMessageIdx >= 0 ? lastUserMessageIdx + 1 : -1;
    return { lastUserMessage, agentResponseStartIdx };
  }, [groupedItems]);

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

  useEffect(() => {
    const scrollEl = chatScrollRef.current;
    const target = lastUserMsgRef.current;
    if (!scrollEl || !target) {
      setShowStickyUserMsg(false);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        const aboveViewport = !entry.isIntersecting && entry.boundingClientRect.bottom < (entry.rootBounds?.top ?? 0);
        setShowStickyUserMsg(aboveViewport);
      },
      { root: scrollEl, threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [lastUserMessage, groupedItems]);

  useEffect(() => {
    const scrollEl = chatScrollRef.current;
    const target = agentResponseStartRef.current;
    if (!scrollEl || !target) {
      setAgentResponseAbove(false);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        const aboveViewport = !entry.isIntersecting && entry.boundingClientRect.bottom < (entry.rootBounds?.top ?? 0);
        setAgentResponseAbove(aboveViewport);
      },
      { root: scrollEl, threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [agentResponseStartIdx, groupedItems]);

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
  let planOverlay: React.ReactNode = null;
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
      if (isPlanPermission(pendingPermission.payload)) {
        planOverlay = (
          <PermissionPrompt
            requestId={pendingPermission.requestId}
            payload={pendingPermission.payload}
            onRespond={handlePermissionRespond}
            fullHeight
          />
        );
      } else {
        bottomBar = (
          <PermissionPrompt
            requestId={pendingPermission.requestId}
            payload={pendingPermission.payload}
            onRespond={handlePermissionRespond}
          />
        );
      }
    } else {
      bottomBar = (
        <div className="sticky bottom-0 z-10 px-16 pb-2.5 pt-1">
          <ComposeBar
            ref={composeBarRef}
            onSend={handleSend}
            onCancel={handleCancel}
            isProcessing={isProcessing}
            commands={availableCommands}
            embeddedContext={promptCapabilities?.embedded_context ?? false}
            logId={execution?.id ?? null}
            projectPath={selectedProject?.path ?? null}
            models={models}
            modelId={modelId}
            actualModelId={actualModelId}
            permissionMode={permissionMode}
            usageState={usageState}
            onModelChange={handleModelChange}
            onPermissionModeChange={setPermissionMode}
          />
        </div>
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
            <div className="sticky top-0 z-10">
              {state.plan && (
                <div className="bg-card border-b border-border">
                  <ActivityPlanPanel entries={state.plan} />
                </div>
              )}
              <AnimatePresence>
                {showStickyUserMsg && lastUserMessage && (
                  <motion.div
                    key="sticky-user-msg"
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.15 }}
                    className="bg-muted/80 backdrop-blur-sm border-b border-border/50 cursor-pointer"
                    onClick={() => lastUserMsgRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  >
                    <div className="flex items-center gap-2 px-3 py-1.5">
                      <div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center flex-shrink-0 text-[10px] font-semibold text-muted-foreground border border-border/50">
                        M
                      </div>
                      <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
                        {parseUserContent(lastUserMessage.content).text}
                      </span>
                      <ChevronUp className="w-3 h-3 text-muted-foreground/50 flex-shrink-0" />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div ref={chatContentRef} className="flex-1 p-3 space-y-3">
              {groupedItems.map((gi, idx) => {
                let element: React.ReactNode = null;
                let key: string = `gi-${idx}`;

                if (gi.type === "toolGroup") {
                  key = `tg-${idx}-${gi.items[0].toolCallId}`;
                  element = <ActivityToolCallGroup items={gi.items} />;
                } else {
                  const item = gi.item;
                  if (item.type === "message") {
                    key = item.item.id;
                    element = <ActivityMessageItem message={item.item} />;
                  } else if (item.type === "thinking") {
                    key = item.item.id;
                    element = <ActivityThinkingBlock thinking={item.item} />;
                  } else if (item.type === "userMessage") {
                    key = item.item.id;
                    element = <ActivityUserMessage message={item.item} />;
                  } else if (item.type === "permissionResponse") {
                    key = item.item.id;
                    element = <PermissionResponseCard item={item.item} />;
                  } else if (item.type === "elicitationSummary") {
                    key = item.item.id;
                    element = <ActivityElicitationSummary item={item.item} />;
                  }
                }

                const isLastUserMsg = gi.type === "solo" && gi.item.type === "userMessage" && gi.item.item === lastUserMessage;
                const isAgentResponseStart = idx === agentResponseStartIdx;

                if (isLastUserMsg || isAgentResponseStart) {
                  return (
                    <div key={key} ref={isLastUserMsg ? lastUserMsgRef : agentResponseStartRef}>
                      {element}
                    </div>
                  );
                }

                return element ? <div key={key}>{element}</div> : null;
              })}
            </div>

            {bottomBar}
          </div>

          {planOverlay && (
            <div className="absolute inset-0 z-30 flex flex-col bg-background">
              {planOverlay}
            </div>
          )}

          <AnimatePresence>
            {showScrollFab && agentResponseAbove && (
              <motion.button
                key="scroll-response-top"
                type="button"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 0.15 }}
                onClick={() => agentResponseStartRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="absolute bottom-14 right-4 z-20 w-8 h-8 rounded-full border backdrop-blur-[4px] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_-1px_0_0_rgba(0,0,0,0.15)] flex items-center justify-center transition-colors bg-card/60 border-border/30 hover:bg-muted/60"
                aria-label="Scroll to start of response"
              >
                <ChevronUp className="w-4 h-4 text-muted-foreground" />
              </motion.button>
            )}
            {showScrollFab && (
              <motion.button
                key="scroll-fab"
                type="button"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 0.15 }}
                onClick={() => scrollToBottom()}
                className={`absolute bottom-4 right-4 z-20 w-8 h-8 rounded-full border backdrop-blur-[4px] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_-1px_0_0_rgba(0,0,0,0.15)] flex items-center justify-center transition-colors ${hasUnread ? "bg-accent/60 border-accent/40 hover:bg-accent/70" : "bg-card/60 border-border/30 hover:bg-muted/60"}`}
                aria-label="Scroll to bottom"
              >
                <ChevronDown className={`w-4 h-4 ${hasUnread ? "text-accent-foreground" : "text-muted-foreground"}`} />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
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
  permissionResponses: Array<{ item: PermissionResponseItem; insertAt: number }>,
  elicitationSummaries: Array<{ item: ElicitationSummaryItem; insertAt: number }>,
): ActivityItem[] {
  if (userMessages.length === 0 && permissionResponses.length === 0 && elicitationSummaries.length === 0) return agentItems;

  type Slot = { insertAt: number; ai: ActivityItem };
  const slots: Slot[] = [
    ...userMessages.map(({ item, insertAt }) => ({ insertAt, ai: { type: "userMessage" as const, item } })),
    ...permissionResponses.map(({ item, insertAt }) => ({ insertAt, ai: { type: "permissionResponse" as const, item } })),
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
