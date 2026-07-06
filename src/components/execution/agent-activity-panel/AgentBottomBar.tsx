import { motion } from "framer-motion";
import { cn } from "@/lib/utils.ts";
import { useSettings } from "@/services/settings.service";
import { ComposeBar } from "../activity/compose-bar/ComposeBar";
import type { ComposeBarHandle } from "../activity/compose-bar/ComposeBar";
import type { ConfigOption, UsageState, AvailableCommand } from "../activity/types";
import type { JsonValue } from "@/types/bindings";
import type { AcpPromptCapabilities } from "../activity/useAcpSessionLifecycle";

interface AgentBottomBarProps {
  isSessionDead: boolean;
  showCompose: boolean;
  composeBarWrapperRef: React.RefObject<HTMLDivElement | null>;
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

export function AgentBottomBar({
  isSessionDead,
  showCompose,
  composeBarWrapperRef,
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
}: AgentBottomBarProps) {
  const { data: appSettings } = useSettings();
  const isCompact = appSettings?.agent_stream_width === "compact";

  if (isSessionDead || !showCompose) return null;

  return (
    <motion.div
      ref={composeBarWrapperRef}
      className={cn("sticky bottom-0 z-10 pb-2.5 pt-1", isCompact ? "px-12" : "px-16")}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
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
      />
    </motion.div>
  );
}
