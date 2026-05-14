import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { Skeleton } from "@/ui/skeleton";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useAcpActivity } from "./activity/useAcpActivity";
import { useAcpSessionLifecycle } from "./activity/useAcpSessionLifecycle";
import { useAcpScrollBehavior } from "./activity/useAcpScrollBehavior";
import { useSelectedProject } from "@/store/projectStore";
import { ActivityMessageItem } from "./activity/ActivityMessageItem";
import { ActivityUserMessage } from "./activity/ActivityUserMessage";
import { ActivityThinkingBlock } from "./activity/ActivityThinkingBlock";
import { ActivityToolCallGroup } from "./activity/ActivityToolCallGroup";
import { ActivityFileCard } from "./activity/ActivityFileCard";
import { ActivityPlanPanel } from "./activity/ActivityPlanPanel";
import { ComposeBar } from "./activity/ComposeBar";
import type { ComposeBarHandle } from "./activity/ComposeBar";
import { PermissionPrompt, isPlanPermission, extractBodyText } from "./activity/PermissionPrompt";
import { PermissionResponseCard } from "./activity/PermissionResponseCard";
import { ElicitationPrompt, parseElicitationFields } from "./activity/ElicitationPrompt";
import { ActivityElicitationSummary } from "./activity/ActivityElicitationSummary";
import type {
  PermissionResponseItem,
  ElicitationSummaryItem,
  UsageState,
} from "./activity/types";
import {
  isRejectOption,
  getOptionName,
  groupToolCalls,
  groupIntoAgentSections,
  mergeLiveItems,
  makeElicitationSummary,
  formatElicitationAnswer,
} from "./activity/utils";
import { AgentResponseSection } from "./activity/AgentResponseSection";
import type { JsonValue } from "@/types/bindings";
import { api } from "@/lib/tauri-utils";
import { useSessionActivityActions } from "@/store/sessionActivityStore";

interface AgentActivityPanelProps {
  sessionKey: number;
  agentId: string | null;
  isSelected?: boolean;
  onUsageChange?: (usage: UsageState | null) => void;
  onWorkingFilesChange?: (sessionKey: number, files: string[]) => void;
  onSessionChangedFilesChange?: (sessionKey: number, files: string[]) => void;
  onOpenPanel?: (panel: "working-files" | "review-changes") => void;
}

function isWorkingFile(path: string): boolean {
  // ACP agents send absolute paths; match .hidden-dir/*.md anywhere in path
  return /\/\.[^/]+\/.*\.md$/.test(path) || /^\.[^/]+\/.*\.md$/.test(path);
}

const WRITE_KINDS = new Set(["edit", "delete", "move", "write_file", "edit_file", "create_file"]);

export function AgentActivityPanel({
  sessionKey,
  agentId,
  isSelected = false,
  onUsageChange,
  onWorkingFilesChange,
  onSessionChangedFilesChange,
  onOpenPanel,
}: AgentActivityPanelProps) {
  const { setStatus: setActivityStatus, removeStatus: removeActivityStatus } =
    useSessionActivityActions();
  const onUsageChangeRef = useRef(onUsageChange);
  onUsageChangeRef.current = onUsageChange;

  const [isProcessing, setIsProcessing] = useState(false);
  const composeBarRef = useRef<ComposeBarHandle>(null);
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
    configOptions,
    configValues,
    usageState,
    availableCommands,
    promptCapabilities,
    pendingPermission,
    setPendingPermission,
    pendingElicitation,
    setPendingElicitation,
  } = useAcpSessionLifecycle(sessionKey, selectedProject?.id ?? null, agentId, onUsageChangeRef);

  const isReady = !liveState.isInitializing;
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
    if (liveState.isInitializing) return;
    setActivityStatus(sessionKey, "idle");
  }, [liveState.isInitializing, sessionKey, setActivityStatus]);

  useEffect(() => {
    if (liveState.sessionEnded) {
      setIsProcessing(false);
      removeActivityStatus(sessionKey);
    }
  }, [liveState.sessionEnded, sessionKey, removeActivityStatus]);

  const agentItemsCountRef = useRef(0);
  agentItemsCountRef.current = liveState.items.length;

  const { workingFiles, sessionChangedFiles } = useMemo(() => {
    const working = new Set<string>();
    const changed = new Set<string>();
    for (const item of liveState.items) {
      if (item.type !== "toolCall") continue;
      const tc = item.item;
      for (const c of tc.content) {
        if (c.type === "diff") {
          changed.add(c.path);
          if (isWorkingFile(c.path)) working.add(c.path);
        }
      }
      if (WRITE_KINDS.has(tc.kind)) {
        for (const loc of tc.locations) {
          changed.add(loc.path);
          if (isWorkingFile(loc.path)) working.add(loc.path);
        }
      }
    }
    return { workingFiles: [...working], sessionChangedFiles: [...changed] };
  }, [liveState.items]);

  const onWorkingFilesChangeRef = useRef(onWorkingFilesChange);
  onWorkingFilesChangeRef.current = onWorkingFilesChange;
  const onSessionChangedFilesChangeRef = useRef(onSessionChangedFilesChange);
  onSessionChangedFilesChangeRef.current = onSessionChangedFilesChange;

  useEffect(() => {
    onWorkingFilesChangeRef.current?.(sessionKey, workingFiles);
    onSessionChangedFilesChangeRef.current?.(sessionKey, sessionChangedFiles);
  }, [sessionKey, workingFiles, sessionChangedFiles]);

  const [liveElicitationSummaries, setLiveElicitationSummaries] = useState<
    Array<{ item: ElicitationSummaryItem; insertAt: number }>
  >([]);
  const [livePermissionResponses, setLivePermissionResponses] = useState<
    Array<{ item: PermissionResponseItem; insertAt: number }>
  >([]);

  const handleConfigChange = useCallback(
    async (optionId: string, value: string) => {
      await api.setAcpConfigOption(sessionKey, optionId, value).catch(console.error);
    },
    [sessionKey],
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
              pendingElicitation.message,
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
            item: makeElicitationSummary(requestId, pendingElicitation.message, "Declined"),
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
    if (liveState.isInitializing || pendingPermission || pendingElicitation)
      return;
    if (!isSelected) return;
    const timer = setTimeout(() => composeBarRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [isSelected, liveState.isInitializing, pendingPermission, pendingElicitation]);

  // Re-focus compose bar when window regains focus
  useEffect(() => {
    if (!isSelected || liveState.sessionEnded) return;
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (
        !focused ||
        liveState.isInitializing ||
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
    pendingPermission,
    pendingElicitation,
  ]);


  const displayItems = useMemo(
    () => mergeLiveItems(liveState.items, livePermissionResponses, liveElicitationSummaries),
    [liveState.items, livePermissionResponses, liveElicitationSummaries],
  );

  const groupedItems = useMemo(() => groupToolCalls(displayItems), [displayItems]);

  const agentSections = useMemo(() => groupIntoAgentSections(groupedItems), [groupedItems]);

  if (liveState.isInitializing) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 p-3 space-y-4">
          <div className="space-y-2 max-w-[70%]">
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="h-3.5 w-72" />
            <Skeleton className="h-3.5 w-56" />
          </div>
          <Skeleton className="h-9 w-64 rounded-lg" />
          <div className="space-y-2 max-w-[60%]">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3.5 w-64" />
          </div>
        </div>
        <div className="px-16 pb-2.5 pt-1">
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  const isSessionDead = liveState.sessionEnded;
  const elicitationContent = pendingElicitation
    ? {
        requestId: pendingElicitation.requestId,
        message: pendingElicitation.message,
        fields: parseElicitationFields(pendingElicitation.payload),
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
            configOptions={configOptions}
            configValues={configValues}
            usageState={usageState}
            onConfigChange={handleConfigChange}
          />
        </div>
      );
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {liveState.plan && (
        <div className="flex-shrink-0 bg-card border-b border-border">
          <ActivityPlanPanel entries={liveState.plan} title={liveState.planTitle} />
        </div>
      )}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <div className="flex-1 relative min-h-0 overflow-hidden">
          <div
            className="absolute inset-0 overflow-y-auto overflow-x-hidden flex flex-col custom-scrollbar"
            ref={chatScrollRef}
            onScroll={handleChatScroll}
            onWheel={handleWheel}
          >
            <div ref={chatContentRef} className="flex-1 p-3 space-y-3">
              {agentSections.map((section) => {
                if (section.type === "standalone") {
                  const gi = section.item;
                  if (gi.type !== "solo" || gi.item.type !== "userMessage") return null;
                  return <ActivityUserMessage key={gi.item.item.id} message={gi.item.item} />;
                }

                const { items, showConnector } = section;
                const firstItem = items[0];
                const sectionKey =
                  firstItem.type === "toolGroup"
                    ? `tg-${firstItem.items[0].toolCallId}`
                    : firstItem.item.type === "toolCall"
                      ? firstItem.item.item.toolCallId
                      : firstItem.item.item.id;

                const children = items.map((gi) => {
                  if (gi.type === "toolGroup") {
                    const groupDone = gi.items.every(
                      (i) => i.status === "completed" || i.status === "error",
                    );
                    const groupWorkingFiles: string[] = [];
                    const groupChangedFiles: string[] = [];
                    if (groupDone) {
                      for (const tc of gi.items) {
                        for (const c of tc.content) {
                          if (c.type === "diff") {
                            if (isWorkingFile(c.path)) groupWorkingFiles.push(c.path);
                            else groupChangedFiles.push(c.path);
                          }
                        }
                        if (WRITE_KINDS.has(tc.kind)) {
                          for (const loc of tc.locations) {
                            if (isWorkingFile(loc.path)) groupWorkingFiles.push(loc.path);
                            else groupChangedFiles.push(loc.path);
                          }
                        }
                      }
                    }
                    const uniqueWorkingFiles = [...new Set(groupWorkingFiles)];
                    const uniqueChangedFiles = [...new Set(groupChangedFiles)];
                    const groupKey = `tg-${gi.items[0].toolCallId}`;
                    return (
                      <div key={groupKey} className="space-y-3">
                        <ActivityToolCallGroup items={gi.items} />
                        {groupDone && uniqueWorkingFiles.length > 0 && (
                          <ActivityFileCard
                            variant="working-files"
                            fileNames={uniqueWorkingFiles}
                            onClick={() => onOpenPanel?.("working-files")}
                          />
                        )}
                        {groupDone && uniqueChangedFiles.length > 0 && (
                          <ActivityFileCard
                            variant="review-changes"
                            fileNames={uniqueChangedFiles}
                            onClick={() => onOpenPanel?.("review-changes")}
                          />
                        )}
                      </div>
                    );
                  }

                  const item = gi.item;
                  if (item.type === "message") {
                    return <ActivityMessageItem key={item.item.id} message={item.item} />;
                  } else if (item.type === "thinking") {
                    return <ActivityThinkingBlock key={item.item.id} thinking={item.item} />;
                  } else if (item.type === "permissionResponse") {
                    return <PermissionResponseCard key={item.item.id} item={item.item} />;
                  } else if (item.type === "elicitationSummary") {
                    return <ActivityElicitationSummary key={item.item.id} item={item.item} />;
                  }
                  return null;
                });

                return (
                  <AgentResponseSection key={sectionKey} showConnector={showConnector}>
                    {children}
                  </AgentResponseSection>
                );
              })}
              <AnimatePresence>{inlinePermission}</AnimatePresence>
            </div>

            {bottomBar}
          </div>

          {planOverlay && (
            <div className="absolute inset-0 z-30 flex flex-col bg-background">{planOverlay}</div>
          )}

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
