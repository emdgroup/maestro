import { useState, useEffect, useRef } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';

interface ExecutionTerminalProps {
  taskId: number;
  taskName: string;
  onClose: () => void;
  isActive: boolean;
}

export function ExecutionTerminal({ taskId, taskName, onClose, isActive }: ExecutionTerminalProps) {
  const [terminalOutput, setTerminalOutput] = useState<string>('');
  const [inputValue, setInputValue] = useState<string>('');
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [sending, setSending] = useState<boolean>(false);
  const terminalRef = useRef<HTMLPreElement>(null);
  const channelRef = useRef<Channel<string> | null>(null);

  // Auto-scroll to bottom when new output arrives
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalOutput]);

  // Attach to terminal and set up streaming
  useEffect(() => {
    if (!isActive) return;

    const attachTerminal = async () => {
      try {
        setLoading(true);
        setError(null);
        setTerminalOutput('');

        // Create a channel for receiving terminal output
        const channel = new Channel<string>();
        channelRef.current = channel;

        // Set up the on_message handler
        channel.onmessage = (message: string) => {
          setTerminalOutput((prev) => prev + message);
        };

        // Invoke attach_terminal with the channel and include_history flag
        await invoke('attach_terminal', {
          task_id: taskId,
          output_channel: channel,
          include_history: true,
        });

        console.log(`[ExecutionTerminal] Attached to task ${taskId}`);
        setLoading(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(`Failed to attach terminal: ${message}`);
        setLoading(false);
        console.error('Attach terminal error:', err);
      }
    };

    attachTerminal();

    return () => {
      // Clean up channel and detach when component unmounts
      detachTerminal();
    };
  }, [isActive, taskId]);

  const detachTerminal = async () => {
    try {
      await invoke('detach_terminal', { taskId: taskId });
      console.log(`[ExecutionTerminal] Detached from task ${taskId}`);
    } catch (err) {
      console.error('Detach terminal error:', err);
    }
  };

  const handleSendInput = async () => {
    if (!inputValue) return;

    try {
      setSending(true);

      // Add to history
      if (inputValue.trim()) {
        setInputHistory((prev) => [...prev, inputValue]);
        setHistoryIndex(-1);
      }

      // Echo input to terminal for visual feedback
      setTerminalOutput((prev) => prev + inputValue + '\n');

      // Send input to PTY
      await invoke('send_terminal_input', {
        task_id: taskId,
        input: inputValue + '\n',
      });

      setInputValue('');
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to send input: ${message}`);
      console.error('Send input error:', err);
    } finally {
      setSending(false);
    }
  };

  const handleSendCtrlC = async () => {
    try {
      setSending(true);
      setTerminalOutput((prev) => prev + '^C\n');
      await invoke('send_terminal_input', {
        task_id: taskId,
        input: '\x03', // Ctrl+C
      });
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to send Ctrl+C: ${message}`);
      console.error('Send Ctrl+C error:', err);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Send on Enter
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSendInput();
      return;
    }

    // Navigate history with arrow keys
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (inputHistory.length === 0) return;

      const newIndex = historyIndex === -1 ? inputHistory.length - 1 : historyIndex - 1;
      if (newIndex >= 0) {
        setHistoryIndex(newIndex);
        setInputValue(inputHistory[newIndex]);
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex === -1) return;

      const newIndex = historyIndex + 1;
      if (newIndex < inputHistory.length) {
        setHistoryIndex(newIndex);
        setInputValue(inputHistory[newIndex]);
      } else {
        setHistoryIndex(-1);
        setInputValue('');
      }
      return;
    }

    // Ctrl+C in input field
    if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      handleSendCtrlC();
      return;
    }
  };

  if (!isActive) {
    return null;
  }

  if (loading) {
    return (
      <div className="execution-terminal modal-backdrop">
        <div className="execution-terminal-container">
          <div className="flex items-center justify-between px-4 py-2 bg-muted border-b border-border">
            <h2>{taskName}</h2>
            <button onClick={onClose} className="terminal-close-button" title="Close terminal">
              ✕
            </button>
          </div>
          <div className="terminal-content">
            <div className="loading-state">Connecting to terminal...</div>
          </div>
        </div>
      </div>
    );
  }

  if (error && !terminalOutput) {
    return (
      <div className="execution-terminal modal-backdrop">
        <div className="execution-terminal-container">
          <div className="flex items-center justify-between px-4 py-2 bg-muted border-b border-border">
            <h2>{taskName}</h2>
            <button onClick={onClose} className="terminal-close-button" title="Close terminal">
              ✕
            </button>
          </div>
          <div className="terminal-content">
            <div className="error-state">
              <div className="text-destructive text-xs mt-1">{error}</div>
              <button
                onClick={() => {
                  setError(null);
                  // Reset and try to reconnect
                }}
                className="retry-button"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="execution-terminal modal-backdrop">
      <div className="execution-terminal-container">
        <div className="flex items-center justify-between px-4 py-2 bg-muted border-b border-border">
          <div>
            <h2>{taskName}</h2>
            {error && <div className="terminal-error-banner">{error}</div>}
          </div>
          <button onClick={onClose} className="terminal-close-button" title="Close terminal">
            ✕
          </button>
        </div>

        <div className="terminal-content">
          <pre className="terminal-output-area" ref={terminalRef}>
            {terminalOutput || '(waiting for output...)'}
          </pre>
        </div>

        <div className="terminal-input-area">
          <div className="input-controls">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type command and press Enter to send (Ctrl+C for SIGINT)..."
              className="border-t border-border p-2 flex gap-2"
              disabled={sending}
              autoFocus
            />
            <button
              onClick={handleSendInput}
              disabled={sending || !inputValue}
              className="send-button"
              title="Send command"
            >
              {sending ? '↓' : '↓'}
            </button>
            <button
              onClick={handleSendCtrlC}
              disabled={sending}
              className="ctrl-c-button"
              title="Send Ctrl+C (SIGINT)"
            >
              Ctrl+C
            </button>
          </div>
          <div className="input-help">
            Enter: send command | Ctrl+C: interrupt | ↑↓: history
          </div>
        </div>
      </div>
    </div>
  );
}
