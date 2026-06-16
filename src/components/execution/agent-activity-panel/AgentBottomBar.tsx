import { motion } from "framer-motion";
import { ComposeBar } from "../activity/compose-bar/ComposeBar";
import type { ComposeBarHandle } from "../activity/compose-bar/ComposeBar";
import { ElicitationPrompt, parseElicitationFields } from "../activity/ElicitationPrompt";
import type { ConfigOption, UsageState, AvailableCommand } from "../activity/types";
import type { AcpPromptCapabilities, JsonValue } from "@/types/bindings";

type ElicitationContent = {
  requestId: string;
  message: string;
  fields: ReturnType<typeof parseElicitationFields>;
};

interface AgentBottomBarProps {
  isSessionDead: boolean;
  elicitationContent: ElicitationContent | null;
  showCompose: boolean;
  composeBarWrapperRef: React.RefObject<HTMLDivElement | null>;
  composeBarRef: React.RefObject<ComposeBarHandle | null>;
  onElicitationSubmit: (requestId: string, values: Record<string, unknown>) => Promise<void>;
  onElicitationDecline: (requestId: string) => Promise<void>;
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
  elicitationContent,
  showCompose,
  composeBarWrapperRef,
  composeBarRef,
  onElicitationSubmit,
  onElicitationDecline,
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
  if (isSessionDead) return null;

  if (elicitationContent) {
    return (
      <ElicitationPrompt
        requestId={elicitationContent.requestId}
        message={elicitationContent.message}
        fields={elicitationContent.fields}
        onSubmit={onElicitationSubmit}
        onDecline={onElicitationDecline}
      />
    );
  }

  if (!showCompose) return null;

  return (
    <motion.div
      ref={composeBarWrapperRef}
      className="sticky bottom-0 z-10 px-16 pb-2.5 pt-1"
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
