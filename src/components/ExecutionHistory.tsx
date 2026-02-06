import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ExecutionLog } from '../types/bindings';
import '../styles/ExecutionHistory.css';

interface ExecutionHistoryProps {
  taskId: number;
}

export function ExecutionHistory({ taskId }: ExecutionHistoryProps) {
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null);

  useEffect(() => {
    loadExecutionLogs();
  }, [taskId]);

  const loadExecutionLogs = async () => {
    try {
      setLoading(true);
      setError(null);
      const logs = await invoke<ExecutionLog[]>('get_execution_logs', { task_id: taskId });
      setLogs(logs);
      if (logs.length > 0) {
        setSelectedLogId(logs[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load execution logs');
    } finally {
      setLoading(false);
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
          </div>

          <div className="log-output">
            <h4>Output</h4>
            <pre className="terminal-output">{selectedLog.output || '(no output)'}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
