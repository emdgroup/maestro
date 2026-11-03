import { useRef } from "react";
import { Channel } from "@tauri-apps/api/core";
import {
  attachTerminal,
  detachTerminal,
  resizeTerminal,
  sendTerminalInput,
} from "@/services/execution.service";
import { TERMINAL_CONTAINER_ATTRIBUTE } from "@/components/common/context-menu/editCommands";
import { useXterm } from "./useXterm";

interface TerminalComponentProps {
  sessionId: string;
}

export function TerminalComponent({ sessionId }: TerminalComponentProps) {
  const terminalRef = useRef<HTMLDivElement>(null);

  useXterm(terminalRef, {
    options: { cursorBlink: true, scrollback: 1000 },
    deps: [sessionId],
    onOpen: (terminal) => {
      // Registered before the first fit so it sends the right size to the PTY straight away.
      terminal.onResize(({ cols, rows }) => {
        resizeTerminal(sessionId, cols, rows).catch((err) => {
          console.error("Failed to resize terminal:", err);
        });
      });
      terminal.onData((data: string) => {
        sendTerminalInput(sessionId, data).catch((err) => {
          console.error("Failed to send terminal input:", err);
        });
      });
      return () => {
        detachTerminal(sessionId).catch(() => {});
      };
    },
    onFit: (terminal) => {
      // fit() triggers onResize -> resizeTerminal() -> SIGWINCH -> program repaints.
      // Reset terminal state before attaching:
      //   - Disable mouse tracking modes that a previous TUI (e.g. claude) may have
      //     enabled without disabling on exit. Without this, bash echoes mouse escape
      //     sequences as raw text when the user clicks in the terminal.
      //   - Clear screen and home cursor so the first visible frame is blank.
      // History replay will re-enable mouse tracking if the remote session set it up.
      terminal.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[2J\x1b[H");

      const channel = new Channel<string>();
      channel.onmessage = (output: string) => {
        terminal.write(output);
      };
      // Retry once after 500ms: the PTY may still be initializing for interactive sessions.
      attachTerminal(sessionId, channel).catch((err) => {
        console.error("Failed to attach terminal:", err);
        setTimeout(() => {
          attachTerminal(sessionId, channel).catch((err2) => {
            console.error("Failed to attach terminal (retry):", err2);
            terminal.write(`\r\nError: Failed to attach terminal: ${err2}\r\n`);
          });
        }, 500);
      });
    },
  });

  return (
    <div className="py-2 pl-2 h-full w-full bg-(--terminal-surface) dark:bg-transparent">
      <div
        ref={terminalRef}
        {...{ [TERMINAL_CONTAINER_ATTRIBUTE]: "" }}
        className="w-full h-full overflow-hidden"
      />
    </div>
  );
}
