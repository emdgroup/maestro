import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Project, ConnectionStatus } from "../types/bindings";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";

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
      <div className="flex items-center gap-3 p-3 text-sm">
        <Badge variant="secondary" className="whitespace-nowrap">🌐 Remote</Badge>
        <Badge
          variant={connectionStatus?.connected ? "default" : "destructive"}
          className="whitespace-nowrap"
          title={connectionStatus?.disconnected_reason || ""}
        >
          {connectionStatus?.connected ? "✓ Connected" : "✗ Disconnected"}
        </Badge>
        {!connectionStatus?.connected && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleRetryConnection}
            disabled={retrying}
            title="Retry connection"
            className="w-6 h-6 p-0"
          >
            {retrying ? "⏳" : "🔄"}
          </Button>
        )}
      </div>
    );
  }

  // Full view
  return (
    <div className="p-4 bg-card border border-border rounded-lg shadow-sm">
      <h3 className="mb-3 text-lg font-semibold text-foreground">{project.name}</h3>

      {project.is_remote && (
        <div className="flex items-center gap-3 my-3 p-2 bg-accent/5 border border-accent/20 rounded-md">
          <Badge variant="secondary" className="text-xs font-semibold whitespace-nowrap">
            🌐 Remote
          </Badge>
          <Badge
            variant={connectionStatus?.connected ? "default" : "destructive"}
            className="text-xs font-medium"
          >
            {connectionStatus?.connected ? "✓ Connected" : "✗ Disconnected"}
          </Badge>
          {!connectionStatus?.connected && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleRetryConnection}
              disabled={retrying}
              title="Retry connection"
              className="w-6 h-6 p-0 ml-auto"
            >
              {retrying ? "⏳" : "🔄"}
            </Button>
          )}
        </div>
      )}

      <p className="m-0 text-xs text-muted-foreground font-mono break-all">
        {project.is_remote && project.ssh_config
          ? `${project.ssh_config.username}@${project.ssh_config.host}:${project.ssh_config.remote_path}`
          : project.path}
      </p>
    </div>
  );
}
