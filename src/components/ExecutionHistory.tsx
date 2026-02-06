import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ExecutionLog } from '../types/bindings';
import { showErrorToast } from './ErrorToast';
import '../styles/ExecutionHistory.css';

interface ExecutionHistoryProps {
  taskId: number;
  projectId: number;
  projectPath: string;
}

/// Calculate human-readable duration between two ISO 8601 timestamps
function calculateDuration(startedAt: string, completedAt: string): string {
  try {
    const start = new Date(startedAt).getTime();
    const end = new Date(completedAt).getTime();
    const diffMs = end - start;

    if (diffMs < 0) return 'invalid';
    if (diffMs < 1000) return `${diffMs}ms`;

    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  } catch {
    return 'unknown';
  }
}

export function ExecutionHistory({ taskId, projectId, projectPath }: ExecutionHistoryProps) {
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const previousLogsRef = useRef<ExecutionLog[]>([]);

  useEffect(() => {
    loadExecutionLogs();
    // Poll for execution status changes every 5 seconds
    const interval = setInterval(loadExecutionLogs, 5000);
    return () => clearInterval(interval);
  }, [taskId]);

  const loadExecutionLogs = async () => {
    try {
      if (loading) {
        // Only show loading state on initial load, not on polling
        setLoading(true);
      }
      setError(null);
      const logs = await invoke<ExecutionLog[]>('get_execution_logs', { task_id: taskId });

      // Check for new paused executions and show notification
      const previousLogs = previousLogsRef.current;
      const newPausedLogs = logs.filter(
        (log) =>
          log.status === 'paused' &&
          !previousLogs.find((prevLog) => prevLog.id === log.id && prevLog.status === 'paused')
      );

      if (newPausedLogs.length > 0 && previousLogs.length > 0) {
        // Only show notification if this isn't the initial load
        showErrorToast(`Execution failed! ${newPausedLogs.length} task(s) paused for review.`);
      }

      previousLogsRef.current = logs;
      setLogs(logs);

      if (logs.length > 0 && !selectedLogId) {
        setSelectedLogId(logs[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load execution logs');
    } finally {
      if (loading) {
        setLoading(false);
      }
    }
  };

  const handleRetry = async () => {
    try {
      setRetrying(true);
      await invoke('retry_execution', {
        project_id: projectId,
        task_id: taskId,
        repo_path: projectPath,
      });
      // Reload logs to show the new execution
      await loadExecutionLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry execution');
    } finally {
      setRetrying(false);
    }
  };

  const handleCancel = async (logId: number) => {
    try {
      await invoke('cancel_execution', { log_id: logId });
      // Reload logs to show updated status
      await loadExecutionLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel execution');
    }
  };

  if (loading) {
    return <div className="execution-history">Loading execution history...</div>;
  }

  if (error) {
    return <div className="execution-history error">Error: {error}</div>;
  }

  if (logs.length === 0) {
    return <div className="execution-history">No executions yet</div>;
  }

  const selectedLog = logs.find((log) => log.id === selectedLogId);

  return (
    <div className="execution-history">
      <div className="execution-logs-list">
        <h3>Executions</h3>
        {logs.map((log) => (
          <div
            key={log.id}
            className={`execution-log-item ${selectedLogId === log.id ? 'selected' : ''}`}
            onClick={() => setSelectedLogId(log.id)}
          >
            <div className="log-header">
              <span className={`status-badge status-${log.status}`}>{log.status}</span>
              <span className="log-timestamp">{new Date(log.started_at).toLocaleString()}</span>
            </div>
          </div>
        ))}
      </div>

      {selectedLog && (
        <div className="execution-log-detail">
          <div className="log-info">
            <div className="info-row">
              <span className="label">Status:</span>
              <span className={`status-badge status-${selectedLog.status}`}>{selectedLog.status}</span>
            </div>
            <div className="info-row">
              <span className="label">Started:</span>
              <span>{new Date(selectedLog.started_at).toLocaleString()}</span>
            </div>
            {selectedLog.completed_at && (
              <div className="info-row">
                <span className="label">Completed:</span>
                <span>{new Date(selectedLog.completed_at).toLocaleString()}</span>
              </div>
            )}

            {selectedLog.status === 'paused' && (
              <div className="action-buttons">
                <button
                  onClick={handleRetry}
                  disabled={retrying}
                  className="retry-button"
                >
                  {retrying ? '⏳ Retrying...' : '🔄 Retry'}
                </button>
                <button
                  onClick={() => handleCancel(selectedLog.id)}
                  className="cancel-button"
                >
                  ❌ Cancel
                </button>
              </div>
            )}
          </div>

          <div className="log-output">
            <h4>Terminal Output</h4>

            {/* Search/filter input */}
            <div className="search-container">
              <input
                type="text"
                placeholder="Search logs..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="search-input"
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm('')}
                  className="clear-search-button"
                  title="Clear search"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Display terminal output with search filtering */}
            <div className="terminal-output-container">
              {selectedLog.terminal_output ? (
                <pre className="terminal-output">
                  {searchTerm
                    ? selectedLog.terminal_output
                        .split('\n')
                        .filter(line =>
                          line.toLowerCase().includes(searchTerm.toLowerCase())
                        )
                        .join('\n') || '(no matching lines)'
                    : selectedLog.terminal_output}
                </pre>
              ) : (
                <pre className="terminal-output">(no terminal output captured)</pre>
              )}
            </div>

            {/* Timestamp information */}
            <div className="execution-timestamps">
              <div className="timestamp-info">
                <span className="label">Execution Time:</span>
                <span>{new Date(selectedLog.started_at).toLocaleString()}</span>
              </div>
              {selectedLog.completed_at && (
                <div className="timestamp-info">
                  <span className="label">Completed:</span>
                  <span>{new Date(selectedLog.completed_at).toLocaleString()}</span>
                  <span className="duration">
                    ({calculateDuration(selectedLog.started_at, selectedLog.completed_at)})
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
