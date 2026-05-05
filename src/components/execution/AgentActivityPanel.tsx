import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useAcpActivity } from "./activity/useAcpActivity";
import { useAcpSessionLifecycle } from "./activity/useAcpSessionLifecycle";
import { useAcpScrollBehavior } from "./activity/useAcpScrollBehavior";
import { useSelectedProject } from "@/store/projectStore";
import { ActivityMessageItem } from "./activity/ActivityMessageItem";
import { ActivityUserMessage, parseUserContent } from "./activity/ActivityUserMessage";
import { ActivityThinkingBlock } from "./activity/ActivityThinkingBlock";
import { ActivityToolCallGroup } from "./activity/ActivityToolCallGroup";
import { ActivityPlanPanel } from "./activity/ActivityPlanPanel";
import { ComposeBar } from "./activity/ComposeBar";
import type { ComposeBarHandle, PermissionMode } from "./activity/ComposeBar";
import { PermissionPrompt, isPlanPermission, extractBodyText } from "./activity/PermissionPrompt";
import { PermissionResponseCard } from "./activity/PermissionResponseCard";
import { ElicitationPrompt, parseElicitationFields } from "./activity/ElicitationPrompt";
import { ActivityElicitationSummary } from "./activity/ActivityElicitationSummary";
import type {
  UserMessageItem,
  PermissionResponseItem,
  ElicitationSummaryItem,
  UsageState,
} from "./activity/types";
import {
  isRejectOption,
  getOptionName,
  groupToolCalls,
  mergeLiveItems,
  makeElicitationSummary,
  formatElicitationAnswer,
} from "./activity/utils";
import type { JsonValue } from "@/types/bindings";
import { api } from "@/lib/tauri-utils";
import { useSessionActivityActions } from "@/store/sessionActivityStore";

interface AgentActivityPanelProps {
  sessionKey: number;
  isSelected?: boolean;
  onUsageChange?: (usage: UsageState | null) => void;
}

export function AgentActivityPanel({
  sessionKey,
  isSelected = false,
  onUsageChange,
}: AgentActivityPanelProps) {
  const { setStatus: setActivityStatus, removeStatus: removeActivityStatus } =
    useSessionActivityActions();
  const onUsageChangeRef = useRef(onUsageChange);
  onUsageChangeRef.current = onUsageChange;

  const [isProcessing, setIsProcessing] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const composeBarRef = useRef<ComposeBarHandle>(null);
  const lastUserMsgRef = useRef<HTMLDivElement>(null);
  const agentResponseStartRef = useRef<HTMLDivElement>(null);
  const showStickyUserMsg = false;
  const agentResponseAbove = false;
  const selectedProject = useSelectedProject();

  useEffect(() => {
    setActivityStatus(sessionKey, "spawning");
    return () => {
      removeActivityStatus(sessionKey);
    };
  }, [sessionKey, setActivityStatus, removeActivityStatus]);

  useEffect(() => {
    const unlisten = listen<string>(`acp://turn-ended/${sessionKey}`, () => {
      setIsProcessing(false);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionKey]);

  const [liveState, liveDispatch] = useAcpActivity(sessionKey);

  const {
    models,
    modelId,
    modelsLoaded,
    usageState,
    availableCommands,
    promptCapabilities,
    pendingPermission,
    setPendingPermission,
    pendingElicitation,
    setPendingElicitation,
  } = useAcpSessionLifecycle(sessionKey, onUsageChangeRef);

  const isReady = !liveState.isInitializing && modelsLoaded;
  const {
    chatScrollRef,
    chatContentRef,
    showScrollFab,
    hasUnread,
    handleWheel,
    handleChatScroll,
    scrollToBottom,
  } = useAcpScrollBehavior(isReady);

  useEffect(() => {
    if (liveState.isInitializing || !modelsLoaded) return;
    setActivityStatus(sessionKey, "idle");
  }, [liveState.isInitializing, modelsLoaded, sessionKey, setActivityStatus]);

  useEffect(() => {
    if (liveState.sessionEnded) {
      setIsProcessing(false);
      removeActivityStatus(sessionKey);
    }
  }, [liveState.sessionEnded, sessionKey, removeActivityStatus]);

  const agentItemsCountRef = useRef(0);
  agentItemsCountRef.current = liveState.items.length;

  const [liveElicitationSummaries, setLiveElicitationSummaries] = useState<
    Array<{ item: ElicitationSummaryItem; insertAt: number }>
  >([]);
  const [livePermissionResponses, setLivePermissionResponses] = useState<
    Array<{ item: PermissionResponseItem; insertAt: number }>
  >([]);

  const handleModelChange = useCallback(
    async (id: string) => {
      const prev = modelId;
      try {
        await api.setAcpModel(sessionKey, id);
      } catch {
        await api.setAcpModel(sessionKey, prev).catch(console.error);
      }
    },
    [sessionKey, modelId],
  );

  const handleElicitationSubmit = useCallback(
    async (requestId: string, values: Record<string, unknown>) => {
      try {
        await api.respondAcpElicitation(sessionKey, requestId, {
          action: "accept",
          content: values,
        } as never);
      } catch {
        /* best-effort */
      }
      if (pendingElicitation) {
        const insertAt = agentItemsCountRef.current;
        setLiveElicitationSummaries((prev) => [
          ...prev,
          {
            item: makeElicitationSummary(
              requestId,
              pendingElicitation.payload,
              formatElicitationAnswer(values),
            ),
            insertAt,
          },
        ]);
      }
      setPendingElicitation(null);
      setActivityStatus(sessionKey, "working");
    },
    [sessionKey, pendingElicitation, setPendingElicitation, setActivityStatus],
  );

  const handleElicitationDecline = useCallback(
    async (requestId: string) => {
      try {
        await api.respondAcpElicitation(sessionKey, requestId, { action: "decline" });
      } catch {
        /* best-effort */
      }
      if (pendingElicitation) {
        const insertAt = agentItemsCountRef.current;
        setLiveElicitationSummaries((prev) => [
          ...prev,
          {
            item: makeElicitationSummary(requestId, pendingElicitation.payload, "Declined"),
            insertAt,
          },
        ]);
      }
      setPendingElicitation(null);
      setActivityStatus(sessionKey, "working");
    },
    [sessionKey, pendingElicitation, setPendingElicitation, setActivityStatus],
  );

  const handlePermissionRespond = useCallback(
    async (requestId: string, optionId: string | null) => {
      try {
        await api.respondAcpPermission(sessionKey, requestId, optionId);
      } catch {
        // best-effort
      }
      if (pendingPermission) {
        const isRejection = !optionId || isRejectOption(pendingPermission.payload, optionId);
        const responseItem: PermissionResponseItem = {
          id: `perm-${requestId}`,
          optionName:
            getOptionName(pendingPermission.payload, optionId) ??
            (isRejection ? "Permission denied" : "Allowed"),
          isRejection,
        };
        const insertAt = agentItemsCountRef.current;
        setLivePermissionResponses((prev) => [...prev, { item: responseItem, insertAt }]);
      }
      setPendingPermission(null);
      setActivityStatus(sessionKey, "working");
    },
    [sessionKey, pendingPermission, setPendingPermission, setActivityStatus],
  );

  useEffect(() => {
    if (!pendingPermission || !isPlanPermission(pendingPermission.payload)) return;
    if (extractBodyText(pendingPermission.payload) !== null) return;
    const options = pendingPermission.payload.options as
      | Array<{ optionId: string; kind: string }>
      | undefined;
    const allowOpt = options?.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
    if (allowOpt) {
      handlePermissionRespond(pendingPermission.requestId, allowOpt.optionId);
    }
  }, [pendingPermission, handlePermissionRespond]);

  const handleSend = useCallback(
    async (content: string, contentBlocks?: JsonValue) => {
      if (isProcessing) return;
      liveDispatch({ type: "finalize_streaming" });
      setIsProcessing(true);
      setActivityStatus(sessionKey, "working");
      try {
        if (contentBlocks) {
          await api.sendAcpPromptStructured(sessionKey, contentBlocks);
        } else {
          await api.sendAcpPrompt(sessionKey, content);
        }
      } catch {
        setIsProcessing(false);
        setActivityStatus(sessionKey, "idle");
      }
    },
    [isProcessing, sessionKey, liveDispatch, setActivityStatus],
  );

  const handleCancel = useCallback(async () => {
    try {
      await api.interruptAcpTurn(sessionKey);
    } catch {
      // Write failed (session already gone) — reset UI directly
      setIsProcessing(false);
      setActivityStatus(sessionKey, "idle");
    }
  }, [sessionKey, setActivityStatus]);

  // Focus compose bar when panel becomes selected and is ready
  useEffect(() => {
    if (liveState.isInitializing || !modelsLoaded || pendingPermission || pendingElicitation)
      return;
    if (!isSelected) return;
    const timer = setTimeout(() => composeBarRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [isSelected, liveState.isInitializing, modelsLoaded, pendingPermission, pendingElicitation]);

  // Re-focus compose bar when window regains focus
  useEffect(() => {
    if (!isSelected || liveState.sessionEnded) return;
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (
        !focused ||
        liveState.isInitializing ||
        !modelsLoaded ||
        pendingPermission ||
        pendingElicitation
      )
        return;
      requestAnimationFrame(() => composeBarRef.current?.focus());
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [
    isSelected,
    liveState.sessionEnded,
    liveState.isInitializing,
    modelsLoaded,
    pendingPermission,
    pendingElicitation,
  ]);

  // 2s: mark session as responsive
  useEffect(() => {
    if (!liveState.isInitializing) return;
    const timer = setTimeout(() => liveDispatch({ type: "set_initialized" }), 2000);
    return () => clearTimeout(timer);
  }, [liveState.isInitializing, liveDispatch]);

  const displayItems = useMemo(
    () => mergeLiveItems(liveState.items, livePermissionResponses, liveElicitationSummaries),
    [liveState.items, livePermissionResponses, liveElicitationSummaries],
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

  if (liveState.isInitializing || !modelsLoaded) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Starting agent...
        </div>
      </div>
    );
  }

  const isSessionDead = liveState.sessionEnded;
  const elicitationContent = pendingElicitation
    ? {
        requestId: pendingElicitation.requestId,
        ...parseElicitationFields(pendingElicitation.payload),
      }
    : null;

  let bottomBar: React.ReactNode = null;
  let inlinePermission: React.ReactNode = null;
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
      if (isPlanPermission(pendingPermission.payload) && extractBodyText(pendingPermission.payload) !== null) {
        planOverlay = (
          <PermissionPrompt
            requestId={pendingPermission.requestId}
            payload={pendingPermission.payload}
            onRespond={handlePermissionRespond}
            fullHeight
          />
        );
      } else {
        inlinePermission = (
          <motion.div
            key={pendingPermission.requestId}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
          >
            <PermissionPrompt
              requestId={pendingPermission.requestId}
              payload={pendingPermission.payload}
              onRespond={handlePermissionRespond}
            />
          </motion.div>
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
            logId={sessionKey}
            projectPath={selectedProject?.path ?? null}
            models={models}
            modelId={modelId}
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
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <div className="flex-1 relative min-h-0 overflow-hidden">
          <div
            className="absolute inset-0 overflow-y-auto overflow-x-hidden flex flex-col custom-scrollbar"
            ref={chatScrollRef}
            onScroll={handleChatScroll}
            onWheel={handleWheel}
          >
            <div className="sticky top-0 z-10">
              {liveState.plan && (
                <div className="bg-card border-b border-border">
                  <ActivityPlanPanel entries={liveState.plan} />
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
                    onClick={() =>
                      lastUserMsgRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
                    }
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

                const isLastUserMsg =
                  gi.type === "solo" &&
                  gi.item.type === "userMessage" &&
                  gi.item.item === lastUserMessage;
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
              <AnimatePresence>{inlinePermission}</AnimatePresence>
            </div>

            {bottomBar}
          </div>

          {planOverlay && (
            <div className="absolute inset-0 z-30 flex flex-col bg-background">{planOverlay}</div>
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
                onClick={() =>
                  agentResponseStartRef.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  })
                }
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
                <ChevronDown
                  className={`w-4 h-4 ${hasUnread ? "text-accent-foreground" : "text-muted-foreground"}`}
                />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
