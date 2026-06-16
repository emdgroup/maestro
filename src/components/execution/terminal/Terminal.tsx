import { useEffect, useRef } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { api } from "@/lib/tauri-utils";
import { getTerminalTheme, getTerminalThemeOnly } from "@/utils/helpers/terminalTheme";
import { useSettings } from "@/services/settings.service";
import "@xterm/xterm/css/xterm.css";

interface TerminalComponentProps {
  taskId: number;
}

export function TerminalComponent({ taskId }: TerminalComponentProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const channelRef = useRef<Channel<string> | null>(null);
  const { data: settings } = useSettings();
  const terminalColorMode = settings?.terminal_color_mode ?? "follow_theme";

  useEffect(() => {
    if (!terminalRef.current) return;

    // Create xterm terminal instance
    const terminal = new Terminal({
      cursorBlink: true,
      scrollback: 1000,
      allowProposedApi: true,
      ...getTerminalTheme(terminalColorMode),
    });

    // Create and load FitAddon for auto-sizing
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    // Enable Unicode 11 for correct wide character / symbol rendering
    const unicode11Addon = new Unicode11Addon();
    terminal.loadAddon(unicode11Addon);
    terminal.unicode.activeVersion = "11";

    // Open terminal in container
    terminal.open(terminalRef.current);

    xtermRef.current = terminal;

    // Register resize handler BEFORE fitAddon.fit() so the initial fit
    // sends the correct dimensions to the backend PTY immediately.
    terminal.onResize(({ cols, rows }) => {
      api.resizeTerminal(taskId, cols, rows).catch((err) => {
        console.error("Failed to resize terminal:", err);
      });
    });

    // Set up Tauri channel for streaming output
    const channel = new Channel<string>();
    channelRef.current = channel;

    channel.onmessage = (output: string) => {
      terminal.write(output);
    };

    // Attach to backend PTY using execution service.
    // Retry once after 500ms — PTY may still be initializing for interactive sessions.
    const tryAttach = () => {
      api.attachTerminal(taskId, channel, null).catch((err) => {
        console.error("Failed to attach terminal:", err);
        setTimeout(() => {
          api.attachTerminal(taskId, channel, null).catch((err2) => {
            console.error("Failed to attach terminal (retry):", err2);
            terminal.write(`\r\nError: Failed to attach terminal: ${err2}\r\n`);
          });
        }, 500);
      });
    };

    // Defer initial fit to next animation frame so xterm's renderer has
    // computed cell dimensions. Calling fit() synchronously after open()
    // causes fit() to be a no-op (cell sizes are 0 until first paint),
    // leaving the terminal at 80×24 until ResizeObserver fires — causing
    // the visible resize flash on session switch. rAF fires before the
    // next paint, so the correct size is set before the user sees anything.
    const rafId = requestAnimationFrame(() => {
      fitAddon.fit();
      // fit() triggers onResize -> api.resizeTerminal() -> SIGWINCH -> program repaints.
      // Reset terminal state before attaching:
      //   - Disable mouse tracking modes that a previous TUI (e.g. claude) may have
      //     enabled without disabling on exit. Without this, bash echoes mouse escape
      //     sequences as raw text when the user clicks in the terminal.
      //   - Clear screen and home cursor so the first visible frame is blank.
      // History replay will re-enable mouse tracking if the remote session set it up.
      terminal.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[2J\x1b[H");
      tryAttach();
    });

    // Set up terminal to send input to backend
    terminal.onData((data: string) => {
      api.sendTerminalInput(taskId, data).catch((err) => {
        console.error("Failed to send terminal input:", err);
      });
    });

    // Auto-resize terminal when container changes size
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(terminalRef.current);

    // Cleanup on unmount
    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      api.detachTerminal(taskId).catch(() => {});
      terminal.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Update theme in-place when color mode changes — no PTY detach/reattach needed.
  useEffect(() => {
    const terminal = xtermRef.current;
    if (!terminal) return;
    terminal.options.theme = getTerminalThemeOnly(terminalColorMode);
  }, [terminalColorMode]);

  return (
    <div className="pt-2 pl-2 h-full w-full">
      <div ref={terminalRef} className="w-full h-full overflow-hidden" />
    </div>
  );
}
