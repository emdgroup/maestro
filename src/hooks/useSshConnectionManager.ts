import { useState, useEffect, useMemo, useCallback } from "react";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";
import { SshConnection } from "../types/bindings";
import { Connection } from "../components/ConnectionList";

/**
 * Custom hook for managing SSH connections and authentication flow.
 *
 * Handles:
 * - Loading and managing SSH connections list
 * - Creating new SSH connections with parsing and validation
 * - Password authentication flow with modal management
 * - Building unified connections list (Local + SSH)
 *
 * @returns SSH connection state, handlers, and unified connections list
 */
export function useSshConnectionManager() {
  const [sshConnections, setSshConnections] = useState<SshConnection[]>([]);
  const [activeConnection, setActiveConnection] = useState<Connection | null>(null);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [loading, setLoading] = useState(false);

  /**
   * Build unified connections list: Local first, then SSH connections
   */
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

  /**
   * Load SSH connections from database
   */
  const loadSshConnections = useCallback(async () => {
    try {
      const connections = await safeInvoke<SshConnection[]>("get_ssh_connections", {});
      setSshConnections(connections);
    } catch (error) {
      console.error("Failed to load SSH connections:", error);
    }
  }, []);

  const initiateConnection = async (connectionId: number) => {
    setLoading(true);
    try {
      // Try connecting without credentials first
      await safeInvoke("connect_ssh_without_credentials", {
        connectionId,
      });
    } catch (error) {
      console.log("Credential-less connection failed, showing password modal", error);
      // Show password modal on auth failure
      setShowPasswordModal(true);
    } finally {
      setLoading(false);
    }
  };

  const handleConnection = useCallback(
    async (connection?: Connection) => {
      const conn = connection || activeConnection;
      if (!conn?.sshConnection) return;
      const { sshConnection } = conn;
      await initiateConnection(sshConnection.id);
      toast.success(`Connected to ${sshConnection.connection_string}`);
    },
    [activeConnection],
  );

  /**
   * Handle new SSH connection creation
   * Saves connection string to database and attempts authentication
   */
  const handleNewConnection = async (connectionString: string) => {
    console.log(`New connection: ${connectionString}`);
    setLoading(true);

    try {
      // Save connection to database (parsing happens in Rust)
      const connectionId = await safeInvoke<number>("save_ssh_connection", {
        connectionString,
        authMethod: "Agent", // Default to Agent auth
      });
      const sshConnection = await safeInvoke<SshConnection>("get_ssh_connection", {
        connectionId,
      });
      setActiveConnection({
        type: "ssh",
        id: connectionId,
        displayName: sshConnection.display_name || sshConnection.connection_string,
        sshConnection,
      });
      await initiateConnection(connectionId);
    } catch (error) {
      toast.error(`Failed to save connection: ${error}`);
      return { success: false };
    } finally {
      setLoading(false);
    }
  };

  /**
   * Handle password authentication submission
   */
  const handlePasswordSubmit = useCallback(
    async (password: string, savePassword: boolean) => {
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

        // Reload connections list (connection now appears after successful auth)
        await loadSshConnections();

        return { success: true };
      } catch (error) {
        toast.error(`Authentication failed: ${error}`);
        return { success: false };
      } finally {
        setLoading(false);
      }
    },
    [activeConnection, loadSshConnections],
  );

  /**
   * Handle password modal cancellation
   */
  const handlePasswordCancel = useCallback(() => {
    setShowPasswordModal(false);
    setActiveConnection(null);
  }, []);

  const handleRemoveConnection = useCallback(async () => {
    if (!activeConnection) return;
    const sshConn = activeConnection.sshConnection;
    if (!sshConn) return;
    setLoading(true);

    try {
      // Try connecting without credentials first
      await safeInvoke("delete_ssh_connection", {
        connectionId: sshConn.id,
      });

      toast.success(`Removed ${sshConn.display_name} from connections`);
      setActiveConnection(null);

      return { success: true };
    } catch (error) {
      console.error(error);
      toast.error(`Failed to remove ${sshConn.display_name} from connections`);
      return { success: false };
    } finally {
      setLoading(false);
    }
  }, [setActiveConnection, setLoading]);

  const handleForgetPassword = useCallback(async () => {
    if (!activeConnection) return;
    const sshConn = activeConnection.sshConnection;
    if (!sshConn) return;
    setLoading(true);

    try {
      // Try connecting without credentials first
      await safeInvoke("forget_saved_password", {
        connectionId: sshConn.id,
      });

      toast.success(`Removed ${sshConn.display_name} password from OS keyring`);
      setActiveConnection(null);

      return { success: true };
    } catch (error) {
      console.error(error);
      toast.error(`Failed to remove ${sshConn.display_name} password`);
      return { success: false };
    } finally {
      setLoading(false);
    }
  }, [setActiveConnection, setLoading]);

  // Load SSH connections on mount
  useEffect(() => {
    void loadSshConnections();
  }, [loadSshConnections]);

  return {
    sshConnections,
    activeConnection,
    connections,
    showPasswordModal,
    loading,
    loadSshConnections,
    handleConnection,
    handleNewConnection,
    handlePasswordSubmit,
    handlePasswordCancel,
    handleRemoveConnection,
    handleForgetPassword,
    setActiveConnection,
  };
}
