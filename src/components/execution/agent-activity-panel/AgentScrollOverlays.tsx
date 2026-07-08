import { useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronUp, User } from "lucide-react";
import { ComposeBar } from "../activity/compose-bar/ComposeBar";
import type { ComposeBarHandle } from "../activity/compose-bar/ComposeBar";
import { parseUserContent } from "../activity/ActivityUserMessage";
import type {
  ConfigOption,
  UsageState,
  AvailableCommand,
  UserMessageItem,
} from "../activity/types";
import type { JsonValue } from "@/types/bindings";
import type { AcpPromptCapabilities } from "../activity/useAcpSessionLifecycle";
import {
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@/ui/message-scroller";

interface AgentScrollOverlaysProps {
  lastUserMessage: UserMessageItem | null;
  isCenteredCompose: boolean;
  planOverlay: React.ReactNode;
  composeBarRef: React.RefObject<ComposeBarHandle | null>;
  onSend: (content: string, contentBlocks?: JsonValue) => void;
  onCancel: () => Promise<void>;
  isProcessing: boolean;
  commands: AvailableCommand[];
  embeddedContext: boolean;
  logId: number;
  projectPath: string | null;
  configOptions: ConfigOption[];
  configValues: Record<string, string>;
  usageState: UsageState | null;
  onConfigChange: (optionId: string, value: string) => Promise<void>;
  promptCapabilities: AcpPromptCapabilities | null;
}

export function AgentScrollOverlays({
  lastUserMessage,
  isCenteredCompose,
  planOverlay,
  composeBarRef,
  onSend,
  onCancel,
  isProcessing,
  commands,
  embeddedContext,
  logId,
  projectPath,
  configOptions,
  configValues,
  usageState,
  onConfigChange,
  promptCapabilities,
}: AgentScrollOverlaysProps) {
  const { scrollToEnd, scrollToMessage } = useMessageScroller();
  const scrollable = useMessageScrollerScrollable();
  const visibility = useMessageScrollerVisibility();

  const showScrollFab = scrollable.end;
  const hasUnread = scrollable.end && isProcessing;
  const isLastUserMsgPinned =
    lastUserMessage !== null &&
    visibility.currentAnchorId === lastUserMessage.id &&
    !visibility.visibleMessageIds.includes(lastUserMessage.id);

  const scrollToBottom = useCallback(() => scrollToEnd({ behavior: "smooth" }), [scrollToEnd]);

  const scrollToLastUserMsg = useCallback(() => {
    if (lastUserMessage) {
      scrollToMessage(lastUserMessage.id, { align: "start", behavior: "smooth" });
    }
  }, [lastUserMessage, scrollToMessage]);

  return (
    <>
      <AnimatePresence>
        {isCenteredCompose && (
          <motion.div
            key="centered-compose"
            className="absolute inset-0 z-10 flex items-center justify-center px-8"
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 30, scale: 0.97 }}
              transition={{ type: "spring", stiffness: 350, damping: 28 }}
              className="transition-[width] duration-150 ease-out"
              style={{
                width: "min(48rem, calc(100% - 4rem))",
              }}
            >
              <ComposeBar
                ref={composeBarRef}
                onSend={onSend}
                onCancel={onCancel}
                isProcessing={isProcessing}
                commands={commands}
                embeddedContext={embeddedContext}
                logId={logId}
                projectPath={projectPath}
                configOptions={configOptions}
                configValues={configValues}
                usageState={usageState}
                onConfigChange={onConfigChange}
                promptCapabilities={promptCapabilities}
                variant="centered"
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {planOverlay && (
        <div className="absolute inset-0 z-30 flex flex-col bg-background">{planOverlay}</div>
      )}

      <AnimatePresence>
        {isLastUserMsgPinned && lastUserMessage && (
          <motion.button
            key="pinned-user-msg"
            type="button"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            onClick={scrollToLastUserMsg}
            className="absolute top-2 left-2 right-2 z-20 flex items-center gap-2 px-3 py-1.5 rounded-xl backdrop-blur-xs bg-input/60 border border-border/30 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),0_4px_12px_rgba(0,0,0,0.3)] cursor-pointer hover:bg-input/70 transition-colors"
            aria-label="Scroll to last message"
          >
            <div className="w-5 h-5 rounded-full bg-gradient-to-br from-accent/60 to-accent/15 flex items-center justify-center shrink-0">
              <User className="w-2.5 h-2.5 text-accent/70" />
            </div>
            <span className="text-xs text-foreground/80 truncate flex-1 min-w-0 text-left">
              {parseUserContent(lastUserMessage.content).text}
            </span>
            <ChevronUp className="w-3 h-3 text-muted-foreground shrink-0 opacity-50" />
          </motion.button>
        )}
      </AnimatePresence>

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
            className={`absolute bottom-4 right-4 z-20 w-8 h-8 rounded-full border backdrop-blur-xs shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_-1px_0_0_rgba(0,0,0,0.15)] flex items-center justify-center transition-colors ${hasUnread ? "bg-accent/15 border-accent/50 hover:bg-accent/25" : "bg-card/60 border-border/30 hover:bg-muted/60"}`}
            aria-label="Scroll to bottom"
          >
            <ChevronDown
              className={`w-4 h-4 ${hasUnread ? "text-accent" : "text-muted-foreground"}`}
            />
          </motion.button>
        )}
      </AnimatePresence>
    </>
  );
}
