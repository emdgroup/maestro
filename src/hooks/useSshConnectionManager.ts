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

  /**
   * Handle new SSH connection creation
   * Parses connection string, saves to database, and attempts authentication
   */
  const handleNewConnection = useCallback(async (connectionString: string) => {
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
      // Save connection to database (get ID for authentication)
      const connectionId = await safeInvoke<number>("save_ssh_connection", {
        connectionString,
        username,
        host,
        port,
        authMethod: JSON.stringify("Agent"), // Default to Agent auth
      });

      // Create connection object for authentication
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

      const newConnection: Connection = {
        type: "ssh",
        id: connectionId,
        displayName: connectionString,
        sshConnection: newSshConnection,
      };

      // Set as active connection but don't switch views yet
      setActiveConnection(newConnection);

      // Try to authenticate
      try {
        await safeInvoke("connect_ssh_without_credentials", {
          connectionId: connectionId,
        });

        // Success! Now reload connections list and return success
        await loadSshConnections();
        toast.success(`Connected to ${connectionString}`);
        return { success: true };
      } catch (authError) {
        console.log("Authentication failed, prompting for password");
        // Show password modal (connection not added to list yet)
        setShowPasswordModal(true);
        return { success: false, needsPassword: true };
      }
    } catch (error) {
      toast.error(`Failed to save connection: ${error}`);
      return { success: false };
    } finally {
      setLoading(false);
    }
  }, [loadSshConnections]);

  /**
   * Handle password authentication submission
   */
  const handlePasswordSubmit = useCallback(async (password: string, savePassword: boolean) => {
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
  }, [activeConnection, loadSshConnections]);

  /**
   * Handle password modal cancellation
   */
  const handlePasswordCancel = useCallback(() => {
    setShowPasswordModal(false);
    setActiveConnection(null);
  }, []);

  // Load SSH connections on mount
  useEffect(() => {
    loadSshConnections();
  }, [loadSshConnections]);

  return {
    sshConnections,
    activeConnection,
    connections,
    showPasswordModal,
    loading,
    loadSshConnections,
    handleNewConnection,
    handlePasswordSubmit,
    handlePasswordCancel,
    setActiveConnection,
    setShowPasswordModal,
  };
}
