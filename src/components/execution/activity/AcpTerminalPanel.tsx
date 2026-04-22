import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { getTerminalTheme } from "@/utils/helpers/terminalTheme";
import "@xterm/xterm/css/xterm.css";

interface AcpTerminalPanelProps {
  logId: number;
}

export function AcpTerminalPanel({ logId }: AcpTerminalPanelProps) {
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    const terminal = new Terminal({
      cursorBlink: false,
      scrollback: 5000,
      disableStdin: true,
      ...getTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalRef.current);

    const rafId = requestAnimationFrame(() => {
      fitAddon.fit();
    });

    // Subscribe to ACP terminal output events — payload is number[] (Vec<u8> serialized by Tauri)
    const unlisten = listen<number[]>(`acp://terminal-output/${logId}`, (event) => {
      terminal.write(new Uint8Array(event.payload));
    });

    const observer = new ResizeObserver(() => fitAddon.fit());
    if (terminalRef.current) {
      observer.observe(terminalRef.current);
    }

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      unlisten.then((fn) => fn());
      terminal.dispose();
    };
  }, [logId]);

  return (
    <div className="pt-1 pl-2 h-full w-full">
      <div ref={terminalRef} className="w-full h-full overflow-hidden" />
    </div>
  );
}
