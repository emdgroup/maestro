import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Project, ConnectionStatus } from "../types/bindings";
import "../styles/ProjectCard.css";

interface ProjectCardProps {
  project: Project;
  compact?: boolean;
}

export function ProjectCard({ project, compact = false }: ProjectCardProps) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!project.is_remote) return;

    // Check connection status on component mount
    const checkStatus = async () => {
      try {
        const status = await invoke<ConnectionStatus>("get_remote_connection_status", {
          projectId: project.id,
        });
        setConnectionStatus(status);
      } catch (error) {
        console.error("Failed to get connection status:", error);
      }
    };

    checkStatus();

    // Poll every 10s for remote projects
    const interval = setInterval(checkStatus, 10000);
    return () => clearInterval(interval);
  }, [project.is_remote, project.id]);

  const handleRetryConnection = async () => {
    if (!project.is_remote) return;

    setRetrying(true);
    try {
      await invoke<void>("reconnect_remote_project", {
        projectId: project.id,
      });

      const status = await invoke<ConnectionStatus>("get_remote_connection_status", {
        projectId: project.id,
      });

      setConnectionStatus(status);

      if (status.connected) {
        toast.success("Reconnected to remote project");
      } else {
        toast.error("Failed to reconnect");
      }
    } catch (error) {
      toast.error(`Reconnection failed: ${error}`);
    } finally {
      setRetrying(false);
    }
  };

  if (compact && project.is_remote) {
    // Compact view - just show badge and status
    return (
      <div className="project-card compact">
        <span className="remote-badge">🌐 Remote</span>
        <span
          className={`connection-status ${
            connectionStatus?.connected ? "connected" : "disconnected"
          }`}
          title={connectionStatus?.disconnected_reason || ""}
        >
          {connectionStatus?.connected ? "✓ Connected" : "✗ Disconnected"}
        </span>
        {!connectionStatus?.connected && (
          <button
            className="retry-btn"
            onClick={handleRetryConnection}
            disabled={retrying}
            title="Retry connection"
          >
            {retrying ? "⏳" : "🔄"}
          </button>
        )}
      </div>
    );
  }

  // Full view
  return (
    <div className="project-card">
      <h3>{project.name}</h3>

      {project.is_remote && (
        <div className="remote-indicator">
          <span className="badge">🌐 Remote</span>
          <span
            className={`status ${connectionStatus?.connected ? "connected" : "disconnected"}`}
          >
            {connectionStatus?.connected ? "✓ Connected" : "✗ Disconnected"}
          </span>
          {!connectionStatus?.connected && (
            <button
              className="retry-btn"
              onClick={handleRetryConnection}
              disabled={retrying}
              title="Retry connection"
            >
              {retrying ? "⏳" : "🔄"}
            </button>
          )}
        </div>
      )}

      <p className="path">
        {project.is_remote && project.ssh_config
          ? `${project.ssh_config.username}@${project.ssh_config.host}:${project.ssh_config.remote_path}`
          : project.path}
      </p>
    </div>
  );
}
