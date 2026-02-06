import { useEffect, useRef } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalComponentProps {
  taskId: number;
}

export function TerminalComponent({ taskId }: TerminalComponentProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const channelRef = useRef<Channel<string> | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Create xterm terminal instance
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      scrollback: 1000,
    });

    // Create and load FitAddon for auto-sizing
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    // Open terminal in container
    terminal.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = terminal;

    // Set up Tauri channel for streaming output
    const channel = new Channel<string>();
    channelRef.current = channel;

    channel.onmessage = (output: string) => {
      terminal.write(output);
    };

    // Attach to backend PTY
    invoke('attach_terminal', { taskId, outputChannel: channel }).catch((err) => {
      console.error('Failed to attach terminal:', err);
      terminal.write(`\r\nError: Failed to attach terminal: ${err}\r\n`);
    });

    // Set up terminal to send input to backend
    terminal.onData((data: string) => {
      invoke('send_terminal_input', { taskId, input: data }).catch((err) => {
        console.error('Failed to send terminal input:', err);
      });
    });

    // Set up terminal resize handler
    terminal.onResize(({ cols, rows }) => {
      invoke('resize_terminal', { taskId, cols, rows }).catch((err) => {
        console.error('Failed to resize terminal:', err);
      });
    });

    // Cleanup on unmount
    return () => {
      terminal.dispose();
      // Channel drop is implicit - when this component unmounts,
      // the channel reference is released and backend detects EOF
    };
  }, [taskId]);

  return (
    <div
      ref={terminalRef}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
      }}
    />
  );
}
