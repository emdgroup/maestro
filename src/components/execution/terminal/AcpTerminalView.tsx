import { useRef } from "react";
import { useTauriEvent } from "@/services/tauri-events";
import { TERMINAL_CONTAINER_ATTRIBUTE } from "@/components/common/context-menu/editCommands";
import { useXterm } from "./useXterm";

interface AcpTerminalViewProps {
  sessionId: string;
  terminalId: string;
  initialOutput: string;
  onInput?: (data: string) => void;
}

function toTerminalOutput(s: string): string {
  return s.replace(/\r?\n/g, "\r\n");
}

export function AcpTerminalView({
  sessionId,
  terminalId,
  initialOutput,
  onInput,
}: AcpTerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const xtermRef = useXterm(containerRef, {
    options: { cursorBlink: false, scrollback: 5000, disableStdin: !onInput },
    deps: [sessionId, terminalId],
    onOpen: (terminal) => {
      if (initialOutput) terminal.write(toTerminalOutput(initialOutput));
      if (!onInput) return;
      const subscription = terminal.onData(onInput);
      return () => subscription.dispose();
    },
  });

  useTauriEvent<{ terminal_id: string; output: string }>(
    `acp://terminal-output/${sessionId}`,
    (payload) => {
      if (payload.terminal_id !== terminalId) return;
      xtermRef.current?.write(toTerminalOutput(payload.output));
    },
  );

  return (
    <div className="pt-2 pl-2 h-full w-full bg-(--terminal-surface) dark:bg-transparent">
      <div
        ref={containerRef}
        {...{ [TERMINAL_CONTAINER_ATTRIBUTE]: "" }}
        className="w-full h-full overflow-hidden"
      />
    </div>
  );
}
