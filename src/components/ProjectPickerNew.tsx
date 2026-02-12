import { useState, useEffect, useMemo } from "react";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";
import { SshConnection } from "../types/bindings";
import { ConnectionList, Connection } from "./ConnectionList";
import { LocalProjectsList } from "./LocalProjectsList";
import { RemoteProjectsList } from "./RemoteProjectsList";
import { PasswordModal } from "./PasswordModal";
import { FilePicker } from "./FilePicker";
import { Dialog, DialogContent } from "./ui/dialog";
import { useRecentProjects } from "../hooks/useRecentProjects";

interface ProjectPickerNewProps {
  onProjectSelected: (path: string) => void;
}

type View = "connections" | "projects";

export function ProjectPickerNew({
  onProjectSelected,
}: ProjectPickerNewProps) {
  const [loading, setLoading] = useState(false);
  const [sshConnections, setSshConnections] = useState<SshConnection[]>([]);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showFilePickerModal, setShowFilePickerModal] = useState(false);
  const [activeConnection, setActiveConnection] = useState<Connection | null>(null);
  const [currentView, setCurrentView] = useState<View>("connections");

  // Load enhanced recent projects with metadata
  const { recentProjects, loading: recentLoading } = useRecentProjects();

  // Build unified connections list: Local first, then SSH connections
  const connections = useMemo<Connection[]>(() => {
    const list: Connection[] = [
      {
        type: "local" as const,
        id: "local",
        displayName: "Local",
        subtitle: "Browse local filesystem",
      },
    ];

    // Add SSH connections
    sshConnections.forEach((conn) => {
      list.push({
        type: "ssh" as const,
        id: conn.id,
        displayName: conn.display_name || conn.connection_string,
        subtitle: conn.display_name ? conn.connection_string : undefined,
        metadata: `Last used: ${new Date(conn.last_used_at).toLocaleDateString()}`,
        sshConnection: conn,
      });
    });

    return list;
  }, [sshConnections]);

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

  async function handleProjectClick(path: string) {
    console.log(`Opening project: ${path}`);
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
    console.log("Opening local file picker");
    // Show file picker modal for local (connection = null)
    setShowFilePickerModal(true);
  }

  async function handleConnectionClick(connection: Connection) {
    if (connection.type === "local") {
      // For local connection, navigate to projects view
      console.log("Local connection selected");
      setActiveConnection(connection);
      setCurrentView("projects");
    } else {
      // For SSH connection, navigate to projects view
      console.log(`Selected SSH connection: ${connection.displayName}`);
      setActiveConnection(connection);
      setCurrentView("projects");
    }
  }

  function handleBackToConnections() {
    setCurrentView("connections");
    setActiveConnection(null);
  }

  async function handleRemoteSelectProject() {
    if (!activeConnection || !activeConnection.sshConnection) return;

    const sshConn = activeConnection.sshConnection;
    console.log(`Opening remote file picker for: ${sshConn.connection_string}`);
    setLoading(true);

    try {
      // Try connecting without credentials first
      await safeInvoke("connect_ssh_without_credentials", {
        connectionId: sshConn.id,
      });

      toast.success(`Connected to ${sshConn.connection_string}`);

      // Show file picker modal
      setShowFilePickerModal(true);
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
      const newSshConnection: SshConnection = {
        id: connectionId,
        connection_string: connectionString,
        username,
        host,
        port,
        auth_method: JSON.stringify("Agent"),
        display_name: null,
        last_used_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };

      // Create Connection wrapper
      const newConnection: Connection = {
        type: "ssh",
        id: connectionId,
        displayName: connectionString,
        sshConnection: newSshConnection,
      };

      // Try connecting
      await handleConnectionClick(newConnection);
    } catch (error) {
      toast.error(`Failed to save connection: ${error}`);
      setLoading(false);
    }
  }

  async function handlePasswordSubmit(password: string, savePassword: boolean) {
    if (!activeConnection || !activeConnection.sshConnection) return;

    const sshConn = activeConnection.sshConnection;
    setLoading(true);
    try {
      await safeInvoke("connect_ssh_with_password", {
        connectionId: sshConn.id,
        password,
        savePassword,
      });

      toast.success(`Connected to ${sshConn.connection_string}`);
      setShowPasswordModal(false);

      // Show file picker modal
      setShowFilePickerModal(true);
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

  async function handleProjectSelect(selectedPath: string) {
    if (!activeConnection) {
      toast.error("No active connection");
      return;
    }

    setLoading(true);

    try {
      if (activeConnection.type === "local") {
        // For local, just open the path directly
        console.log(`Opening local project at: ${selectedPath}`);
        onProjectSelected(selectedPath);
      } else {
        // For remote, create remote project
        if (!activeConnection.sshConnection) {
          toast.error("No active SSH connection");
          return;
        }

        const sshConn = activeConnection.sshConnection;
        console.log(`Creating remote project at: ${selectedPath}`);

        // Parse auth method from string
        const authMethod = JSON.parse(sshConn.auth_method);

        // Create SSH config (use snake_case for Rust struct compatibility)
        const sshConfig = {
          host: sshConn.host,
          port: sshConn.port,
          username: sshConn.username,
          auth_method: authMethod,
          remote_path: selectedPath,
        };

        // Create remote project
        const project = await safeInvoke<{ path: string }>("create_project", {
          name: `${sshConn.host}:${selectedPath}`,
          path: selectedPath,
          isRemote: true,
          sshConfig: sshConfig,
        });

        console.log(`Remote project created: ${project.path}`);
        toast.success(`Remote project created at ${selectedPath}`);

        // Open the project
        onProjectSelected(project.path);
      }
    } catch (error) {
      toast.error(`Failed to open project: ${error}`);
      setLoading(false);
    }
  }

  async function handleRemoveRecentProject(path: string) {
    try {
      await safeInvoke("remove_recent_project", { path });
      toast.success("Project removed from recent list");
      // Trigger a refresh by updating the key or reloading
      window.location.reload();
    } catch (error) {
      toast.error(`Failed to remove project: ${error}`);
    }
  }


  // Main screen with unified connection list
  return (
    <>
      <div className="flex items-center justify-center min-h-screen bg-background text-foreground p-8">
        <div className="max-w-3xl w-full">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-semibold mb-3">
              Welcome to GSD Agent Orchestrator
            </h1>
            <p className="text-base text-muted-foreground">
              Select a connection to get started
            </p>
          </div>

          {/* Single Panel with Slide Transition */}
          <div className="bg-card border border-border rounded-lg p-6 min-h-125 overflow-hidden relative">
            {/* Connections View */}
            <div
              className={`transition-transform duration-300 ease-in-out flex-col h-full ${
                currentView === "projects" ? "-translate-x-full invisible" : "translate-x-0"
              }`}
            >
              <ConnectionList
                connections={connections}
                onConnectionClick={handleConnectionClick}
                onNewConnection={handleNewConnection}
                loading={loading || recentLoading}
              />
            </div>

            {/* Projects View */}
            <div
              className={`absolute inset-0 p-6 transition-transform duration-300 ease-in-out ${
                currentView === "projects" ? "translate-x-0" : "translate-x-full"
              }`}
            >
              {activeConnection && activeConnection.type === "local" && (
                <LocalProjectsList
                  recentProjects={recentProjects}
                  onProjectClick={handleProjectClick}
                  onSelectNewClick={handleSelectNewLocal}
                  onBack={handleBackToConnections}
                  onRemoveProject={handleRemoveRecentProject}
                  loading={loading}
                />
              )}
              {activeConnection && activeConnection.type === "ssh" && activeConnection.sshConnection && (
                <RemoteProjectsList
                  connection={activeConnection.sshConnection}
                  recentProjects={recentProjects}
                  onProjectClick={handleProjectClick}
                  onSelectNewClick={handleRemoteSelectProject}
                  onBack={handleBackToConnections}
                  onRemoveProject={handleRemoveRecentProject}
                  onConnectionRenamed={loadSshConnections}
                  loading={loading}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Password Modal */}
      <PasswordModal
        open={showPasswordModal}
        connection={activeConnection?.sshConnection || null}
        onSubmit={handlePasswordSubmit}
        onCancel={handlePasswordCancel}
        loading={loading}
      />

      {/* File Picker Modal (Local or Remote) */}
      <Dialog open={showFilePickerModal} onOpenChange={setShowFilePickerModal}>
        <DialogContent className="max-w-4xl h-150 p-0 flex flex-col">
          <FilePicker
            connection={activeConnection?.sshConnection || null}
            onProjectSelect={handleProjectSelect}
            loading={loading}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
