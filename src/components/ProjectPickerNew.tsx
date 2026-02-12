import { useState, useEffect } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";
import { SshConnection } from "../types/bindings";
import { LocalSection } from "./LocalSection";
import { RemoteSection } from "./RemoteSection";
import { PasswordModal } from "./PasswordModal";
import { RemoteFilePicker } from "./RemoteFilePicker";
import { useRecentProjects } from "../hooks/useRecentProjects";

interface ProjectPickerNewProps {
  onProjectSelected: (path: string) => void;
}

type Stage = "main" | "remote-project-picker";

export function ProjectPickerNew({
  onProjectSelected,
}: ProjectPickerNewProps) {
  const [stage, setStage] = useState<Stage>("main");
  const [loading, setLoading] = useState(false);
  const [sshConnections, setSshConnections] = useState<SshConnection[]>([]);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [activeConnection, setActiveConnection] = useState<SshConnection | null>(null);

  // Load enhanced recent projects with metadata
  const { recentProjects, loading: recentLoading } = useRecentProjects();

  // Load SSH connections on mount
  useEffect(() => {
    loadSshConnections();
  }, []);

  async function loadSshConnections() {
    try {
      const connections = await safeInvoke<SshConnection[]>("get_ssh_connections", {});
      setSshConnections(connections);
    } catch (error) {
      console.error("Failed to load SSH connections:", error);
    }
  }

  async function handleLocalProjectClick(path: string) {
    console.log(`Opening local project: ${path}`);
    setLoading(true);
    try {
      onProjectSelected(path);
    } catch (error) {
      toast.error(`Failed to open project: ${error}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectNewLocal() {
    console.log("Opening folder dialog");
    setLoading(true);
    try {
      const selectedPath = await openDialog({
        directory: true,
        multiple: false,
        title: "Select Project Directory",
      });

      if (selectedPath) {
        console.log(`Dialog returned path: ${selectedPath}`);
        onProjectSelected(selectedPath as string);
      }
    } catch (error) {
      toast.error(`Failed to select folder: ${error}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleConnectionClick(connection: SshConnection) {
    console.log(`Connecting to: ${connection.connection_string}`);
    setLoading(true);
    setActiveConnection(connection);

    try {
      // Try connecting without credentials first
      await safeInvoke("connect_ssh_without_credentials", {
        connectionId: connection.id,
      });

      toast.success(`Connected to ${connection.connection_string}`);

      // Navigate to remote project picker
      setStage("remote-project-picker");
    } catch (error) {
      console.log("Credential-less connection failed, showing password modal");
      // Show password modal on auth failure
      setShowPasswordModal(true);
    } finally {
      setLoading(false);
    }
  }

  async function handleNewConnection(connectionString: string) {
    console.log(`New connection: ${connectionString}`);

    // Parse connection string: user@host:port or user@host
    const parts = connectionString.split("@");
    if (parts.length !== 2) {
      toast.error("Invalid format. Use: user@host:port or user@host");
      return;
    }

    const username = parts[0];
    const hostPart = parts[1];
    const [host, portStr] = hostPart.includes(":")
      ? hostPart.split(":")
      : [hostPart, "22"];
    const port = parseInt(portStr, 10);

    if (!host || isNaN(port)) {
      toast.error("Invalid host or port");
      return;
    }

    setLoading(true);

    try {
      // Save connection to database
      const connectionId = await safeInvoke<number>("save_ssh_connection", {
        connectionString,
        username,
        host,
        port,
        authMethod: JSON.stringify("Agent"), // Default to Agent auth
      });

      // Reload connections list
      await loadSshConnections();

      // Find the newly created connection
      const newConnection: SshConnection = {
        id: connectionId,
        connection_string: connectionString,
        username,
        host,
        port,
        auth_method: JSON.stringify("Agent"),
        last_used_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };

      // Try connecting
      await handleConnectionClick(newConnection);
    } catch (error) {
      toast.error(`Failed to save connection: ${error}`);
      setLoading(false);
    }
  }

  async function handlePasswordSubmit(password: string, savePassword: boolean) {
    if (!activeConnection) return;

    setLoading(true);
    try {
      await safeInvoke("connect_ssh_with_password", {
        connectionId: activeConnection.id,
        password,
        savePassword,
      });

      toast.success(`Connected to ${activeConnection.connection_string}`);
      setShowPasswordModal(false);

      // Navigate to remote project picker
      setStage("remote-project-picker");
    } catch (error) {
      toast.error(`Authentication failed: ${error}`);
    } finally {
      setLoading(false);
    }
  }

  function handlePasswordCancel() {
    setShowPasswordModal(false);
    setActiveConnection(null);
  }

  async function handleRemoteProjectSelect(remotePath: string) {
    if (!activeConnection) {
      toast.error("No active SSH connection");
      return;
    }

    console.log(`Creating remote project at: ${remotePath}`);
    setLoading(true);

    try {
      // Parse auth method from string
      const authMethod = JSON.parse(activeConnection.auth_method);

      // Create SSH config
      const sshConfig = {
        host: activeConnection.host,
        port: activeConnection.port,
        username: activeConnection.username,
        auth_method: authMethod,
        remote_path: remotePath,
      };

      // Create remote project
      const project = await safeInvoke<{ path: string }>("create_project", {
        name: `${activeConnection.host}:${remotePath}`,
        path: remotePath,
        is_remote: true,
        ssh_config: sshConfig,
      });

      console.log(`Remote project created: ${project.path}`);
      toast.success(`Remote project created at ${remotePath}`);

      // Open the project
      onProjectSelected(project.path);
    } catch (error) {
      toast.error(`Failed to create remote project: ${error}`);
      setLoading(false);
    }
  }

  function handleBackToMain() {
    setStage("main");
    setActiveConnection(null);
  }

  // Show remote project picker if SSH connection is established
  if (stage === "remote-project-picker" && activeConnection) {
    return (
      <RemoteFilePicker
        connection={activeConnection}
        onProjectSelect={handleRemoteProjectSelect}
        onBack={handleBackToMain}
      />
    );
  }

  // Main screen with local and remote sections
  return (
    <>
      <div className="flex items-center justify-center min-h-screen bg-background text-foreground p-8">
        <div className="max-w-5xl w-full">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-semibold mb-3">
              Welcome to GSD Agent Orchestrator
            </h1>
            <p className="text-base text-muted-foreground">
              Select a project directory to get started
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8">
            {/* Local Section */}
            <div className="bg-card border border-border rounded-lg p-6 min-h-[500px]">
              <LocalSection
                recentProjects={recentProjects}
                onProjectClick={handleLocalProjectClick}
                onSelectNewClick={handleSelectNewLocal}
                loading={loading || recentLoading}
              />
            </div>

            {/* Remote Section */}
            <div className="bg-card border border-border rounded-lg p-6 min-h-[500px]">
              <RemoteSection
                sshConnections={sshConnections}
                onConnectionClick={handleConnectionClick}
                onNewConnection={handleNewConnection}
                loading={loading}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Password Modal */}
      <PasswordModal
        open={showPasswordModal}
        connection={activeConnection}
        onSubmit={handlePasswordSubmit}
        onCancel={handlePasswordCancel}
        loading={loading}
      />
    </>
  );
}
