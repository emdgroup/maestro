import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { getTerminalTheme, getTerminalThemeOnly } from "@/utils/helpers/terminalTheme";
import { useSettings } from "@/services/settings.service";
import "@xterm/xterm/css/xterm.css";

interface AcpTerminalViewProps {
  logId: number;
  terminalId: string;
  initialOutput: string;
}

function toTerminalOutput(s: string): string {
  return s.replace(/\r?\n/g, "\r\n");
}

export function AcpTerminalView({ logId, terminalId, initialOutput }: AcpTerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const { data: settings } = useSettings();
  const terminalColorMode = settings?.terminal_color_mode ?? "follow_theme";

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      cursorBlink: false,
      scrollback: 5000,
      allowProposedApi: true,
      disableStdin: true,
      ...getTerminalTheme(terminalColorMode),
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const unicode11Addon = new Unicode11Addon();
    terminal.loadAddon(unicode11Addon);
    terminal.unicode.activeVersion = "11";

    terminal.open(containerRef.current);
    xtermRef.current = terminal;

    if (initialOutput) {
      terminal.write(toTerminalOutput(initialOutput));
    }

    const rafId = requestAnimationFrame(() => {
      fitAddon.fit();
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    const unlisten = listen<{ terminal_id: string; output: string }>(
      `acp://terminal-output/${logId}`,
      (event) => {
        if (event.payload.terminal_id !== terminalId) return;
        terminal.write(toTerminalOutput(event.payload.output));
      },
    ).catch(console.error);

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      unlisten.then((fn) => fn?.());
      terminal.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logId, terminalId]);

  useEffect(() => {
    const terminal = xtermRef.current;
    if (!terminal) return;
    terminal.options.theme = getTerminalThemeOnly(terminalColorMode);
  }, [terminalColorMode]);

  return (
    <div className="pt-2 pl-2 h-full w-full">
      <div ref={containerRef} className="w-full h-full overflow-hidden" />
    </div>
  );
}
