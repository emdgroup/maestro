import { useEffect, useRef, useState } from "react";
import { ExecutionLog } from "@/types/bindings";
import { showErrorToast, showSuccessToast } from "@/components/common/ErrorToast";
import { useBoardStore } from "@/store/boardStore";
import { useExecutionLogsQuery } from "@/services/task.service";
import { toast } from "sonner";
import { api } from "@/lib";

interface ExecutionHistoryProps {
  taskId: number;
  projectId: number;
  projectPath: string;
  taskName?: string;
}

/// Calculate human-readable duration between two ISO 8601 timestamps
function calculateDuration(startedAt: string, completedAt: string): string {
  try {
    const start = new Date(startedAt).getTime();
    const end = new Date(completedAt).getTime();
    const diffMs = end - start;

    if (diffMs < 0) return "invalid";
    if (diffMs < 1000) return `${diffMs}ms`;

    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  } catch {
    return "unknown";
  }
}

export function ExecutionHistory({
  taskId,
  projectId,
  projectPath,
  taskName,
}: ExecutionHistoryProps) {
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const previousLogsRef = useRef<ExecutionLog[]>([]);
  const store = useBoardStore();

  // Replace manual polling with TanStack Query
  const {
    data: logs = [],
    isLoading: loading,
    error: queryError
  } = useExecutionLogsQuery(taskId);

  const error = queryError ? (queryError instanceof Error ? queryError.message : "Failed to load execution logs") : null;

  // Set initial selected log when logs load
  useEffect(() => {
    if (logs.length > 0 && !selectedLogId) {
      setSelectedLogId(logs[0].id);
    }
  }, [logs, selectedLogId]);

  // Monitor logs for changes and show notifications
  useEffect(() => {
    if (!logs.length) return;

    const previousLogs = previousLogsRef.current;

    // Check for new paused executions
    const newPausedLogs = logs.filter(
      (log) =>
        log.status === "paused" &&
        !previousLogs.find((prevLog) => prevLog.id === log.id && prevLog.status === "paused"),
    );

    if (newPausedLogs.length > 0 && previousLogs.length > 0) {
      showErrorToast(`Execution failed! ${newPausedLogs.length} task(s) paused for review.`);
    }

    // Detect new failures
    const newFailedLogs = logs.filter(
      (log) =>
        log.status === "failed" &&
        !previousLogs.find((prevLog) => prevLog.id === log.id && prevLog.status === "failed"),
    );

    if (newFailedLogs.length > 0 && previousLogs.length > 0) {
      newFailedLogs.forEach((log) => {
        const errorType = log.error_event?.error_type || "Unknown Error";
        const displayName = taskName || `Task ${taskId}`;
        toast.error(`Failed: ${displayName} — ${errorType}`, { duration: 10000 });
      });
    }

    previousLogsRef.current = logs;
  }, [logs, taskName, taskId]);

  const handleRetry = async () => {
    try {
      setRetrying(true);
      await api.retryExecution(projectId, taskId, projectPath);
      // TanStack Query will automatically refetch
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : "Failed to retry execution");
    } finally {
      setRetrying(false);
    }
  };

  const handleCancel = async (logId: number) => {
    try {
      await api.cancelExecution(logId);
      // TanStack Query will automatically refetch
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : "Failed to cancel execution");
    }
  };

  const getErrorTypeColor = (errorType: string): string => {
    switch (errorType) {
      case "CompilationError":
        return "#f97316"; // Orange
      case "MissingDependency":
        return "#ef4444"; // Red
      case "RuntimeError":
        return "#ef4444"; // Red
      case "Timeout":
        return "#eab308"; // Yellow
      case "ProcessCrash":
        return "#ef4444"; // Red
      default:
        return "#6b7280"; // Gray
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        showSuccessToast("Copied to clipboard");
      })
      .catch(() => {
        showErrorToast("Failed to copy");
      });
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
            className={`execution-log-item ${selectedLogId === log.id ? "selected" : ""}`}
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
              <span className={`status-badge status-${selectedLog.status}`}>
                {selectedLog.status}
              </span>
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

            {selectedLog.status === "paused" && (
              <div className="action-buttons">
                <button onClick={handleRetry} disabled={retrying} className="retry-button">
                  {retrying ? "⏳ Retrying..." : "🔄 Retry"}
                </button>
                <button onClick={() => handleCancel(selectedLog.id)} className="cancel-button">
                  ❌ Cancel
                </button>
              </div>
            )}

            {selectedLog.status === "failed" && (
              <button
                onClick={() => {
                  try {
                    store.resumeExecution(projectId, taskId, projectPath);
                    showSuccessToast("Retrying execution...");
                  } catch (err) {
                    showErrorToast(
                      `Failed to resume: ${err instanceof Error ? err.message : String(err)}`,
                    );
                  }
                }}
                className="retry-button"
                disabled={retrying}
                style={{ marginTop: "12px", width: "100%" }}
              >
                {retrying ? "⏳ Retrying..." : "🔄 Resume Execution"}
              </button>
            )}
          </div>

          {selectedLog.error_event && (
            <div
              style={{
                marginTop: "16px",
                padding: "12px",
                backgroundColor: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: "6px",
                marginBottom: "12px",
              }}
            >
              <h4 style={{ margin: "0 0 8px 0", color: "#991b1b" }}>Error Details</h4>

              <div style={{ marginBottom: "8px" }}>
                <span
                  style={{
                    display: "inline-block",
                    padding: "4px 8px",
                    backgroundColor: getErrorTypeColor(selectedLog.error_event.error_type),
                    color: "white",
                    borderRadius: "4px",
                    fontSize: "12px",
                    fontWeight: "bold",
                  }}
                >
                  {selectedLog.error_event.error_type}
                </span>
              </div>

              <div
                style={{
                  marginBottom: "8px",
                  padding: "8px",
                  backgroundColor: "#fffbeb",
                  border: "1px solid #fcd34d",
                  borderRadius: "4px",
                  fontSize: "12px",
                  color: "#404000",
                  maxHeight: "100px",
                  overflow: "auto",
                  fontFamily: "monospace",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {selectedLog.error_event.message}
                <button
                  onClick={() => copyToClipboard(selectedLog.error_event?.message || "")}
                  style={{
                    marginLeft: "8px",
                    padding: "2px 6px",
                    backgroundColor: "transparent",
                    border: "1px solid #fcd34d",
                    borderRadius: "2px",
                    cursor: "pointer",
                    fontSize: "10px",
                  }}
                  title="Copy error message"
                >
                  📋
                </button>
              </div>

              {selectedLog.error_event.suggestions &&
                selectedLog.error_event.suggestions.length > 0 && (
                  <div
                    style={{
                      marginBottom: "8px",
                      padding: "8px",
                      backgroundColor: "#f0fdf4",
                      border: "1px solid #86efac",
                      borderRadius: "4px",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "12px",
                        fontWeight: "bold",
                        color: "#166534",
                        marginBottom: "6px",
                      }}
                    >
                      Suggested Actions:
                    </div>
                    <ul
                      style={{
                        margin: "0",
                        paddingLeft: "20px",
                        fontSize: "12px",
                        color: "#15803d",
                      }}
                    >
                      {selectedLog.error_event.suggestions.map((suggestion, idx) => (
                        <li key={idx} style={{ marginBottom: "4px" }}>
                          ✓ {suggestion}
                        </li>
                      ))}
                    </ul>
                    <button
                      onClick={() =>
                        copyToClipboard(selectedLog.error_event?.suggestions.join("\n") || "")
                      }
                      style={{
                        marginTop: "6px",
                        padding: "2px 6px",
                        backgroundColor: "transparent",
                        border: "1px solid #86efac",
                        borderRadius: "2px",
                        cursor: "pointer",
                        fontSize: "10px",
                        color: "#166534",
                      }}
                      title="Copy suggestions"
                    >
                      📋 Copy
                    </button>
                  </div>
                )}

              <div
                style={{
                  fontSize: "11px",
                  color: "#666",
                  marginTop: "6px",
                }}
              >
                Detected: {new Date(selectedLog.error_event.detected_at).toLocaleString()}
              </div>
            </div>
          )}

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
                  onClick={() => setSearchTerm("")}
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
                <pre className="flex-1 overflow-auto p-4 font-mono text-xs bg-background text-foreground">
                  {searchTerm
                    ? selectedLog.terminal_output
                        .split("\n")
                        .filter((line) => line.toLowerCase().includes(searchTerm.toLowerCase()))
                        .join("\n") || "(no matching lines)"
                    : selectedLog.terminal_output}
                </pre>
              ) : (
                <pre className="flex-1 overflow-auto p-4 font-mono text-xs bg-background text-foreground">
                  (no terminal output captured)
                </pre>
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
