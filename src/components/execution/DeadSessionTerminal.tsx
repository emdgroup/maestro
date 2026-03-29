import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { formatDistanceStrict } from "date-fns";
import type { ExecutionWithTask } from "@/types/bindings";
import "@xterm/xterm/css/xterm.css";

function SessionEndedBanner({ execution }: { execution: ExecutionWithTask }) {
  const end = execution.completed_at ? new Date(execution.completed_at) : null;
  const elapsed = formatDistanceStrict(new Date(execution.started_at), end ?? new Date());

  const label = execution.status === "failed" ? "Session failed" : "Session ended";
  const detail = end ? `${end.toLocaleString()} · ${elapsed}` : elapsed;

  return (
    <div className="h-8 border-b border-border bg-muted/30 flex items-center px-3 text-xs text-muted-foreground shrink-0">
      {label} · {detail}
    </div>
  );
}

interface DeadSessionTerminalProps {
  execution: ExecutionWithTask;
}

export function DeadSessionTerminal({ execution }: DeadSessionTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    const terminal = new Terminal({
      cursorBlink: false,
      fontSize: 14,
      scrollback: 5000,
      disableStdin: true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalRef.current);
    fitAddon.fit();

    // Write DB-stored terminal output (REQ-21)
    if (execution.terminal_output) {
      terminal.write(execution.terminal_output);
    }

    // Auto-resize on container change
    const observer = new ResizeObserver(() => fitAddon.fit());
    observer.observe(terminalRef.current);

    return () => {
      observer.disconnect();
      terminal.dispose();
    };
  }, [execution.id]);

  return (
    <div className="flex flex-col h-full">
      <SessionEndedBanner execution={execution} />
      <div ref={terminalRef} className="flex-1 overflow-hidden" />
    </div>
  );
}
