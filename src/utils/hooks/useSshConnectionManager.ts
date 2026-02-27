import { useState, useCallback, useRef, useEffect } from "react";
import { toast } from "sonner";
import { commands, SshConnection } from "@/types/bindings.ts";
import { Connection, localConnectionId } from "@/contexts/ConnectionContext.tsx";
import { useSshConnections } from "@/services/connection.service.ts";

interface sshConnectionManagerProps {
  onConnectionSuccess: (connection: Connection) => void;
}

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
export function useSshConnectionManager({ onConnectionSuccess }: sshConnectionManagerProps) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState<number | null>(null);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const { data: sshConnections = [], refetch: refetchConnections } = useSshConnections();

  const local = useRef<Connection>({
    type: "local" as const,
    id: localConnectionId,
    displayName: "Local",
    subtitle: "Browse local filesystem",
  });

  const buildConnection = useCallback(
    (sshConn: SshConnection) => ({
      type: "ssh" as const,
      id: sshConn.id,
      displayName: sshConn.display_name || sshConn.connection_string,
      subtitle: sshConn.display_name ? sshConn.connection_string : undefined,
      metadata: `Last used: ${new Date(sshConn.last_used_at).toLocaleDateString()}`,
      sshConnection: sshConn,
    }),
    [],
  );

  useEffect(() => {
    setConnections([local.current, ...sshConnections.map(buildConnection)]);
  }, [sshConnections, buildConnection]);

  /**
   * Helper to fetch a connection by ID and construct Connection object
   * Refetches from server to ensure data is fresh, then returns the specific connection
   */
  const getConnectionById = useCallback(
    async (id: number): Promise<Connection | null> => {
      try {
        // Refetch to ensure we have the latest data (TanStack Query will update cache)
        const { data } = await refetchConnections();

        const sshConn = data?.find((conn) => conn.id === id);
        return sshConn ? buildConnection(sshConn) : null;
      } catch (error) {
        console.error("Failed to get connection:", error);
        return null;
      }
    },
    [refetchConnections, buildConnection],
  );

  const initiateConnection = useCallback(
    async (connId: number) => {
      setLoading(true);
      setConnectionId(connId);
      try {
        // Try connecting without credentials first
        await commands.connectSshWithoutCredentials(connId);

        // Fetch fresh connection data and call callback
        // (getConnectionById also updates state, so no separate reload needed)
        const connection = await getConnectionById(connId);
        if (connection) {
          onConnectionSuccess(connection);
        } else {
          toast.error("Failed to retrieve connection details");
        }
      } catch (error) {
        console.log("Credential-less connection failed, showing password modal", error);
        // Show password modal on auth failure
        setShowPasswordModal(true);
      } finally {
        setLoading(false);
      }
    },
    [onConnectionSuccess, getConnectionById],
  );

  const handleConnection = useCallback(
    async (connection: Connection) => {
      if (connection.type === "local") {
        onConnectionSuccess(local.current);
      } else if (connection.sshConnection) {
        await initiateConnection(connection.sshConnection.id);
      }
    },
    [onConnectionSuccess, initiateConnection],
  );

  /**
   * Handle new SSH connection creation
   * Saves connection string to database and attempts authentication
   */
  const handleNewConnection = useCallback(
    async (connectionString: string) => {
      console.log(`New connection: ${connectionString}`);
      setLoading(true);

      try {
        // Save connection to database (parsing happens in Rust)
        const result = await commands.saveSshConnection(
          connectionString,
          "Agent", // Default to Agent auth
        );
        if (result.status === "ok") {
          await initiateConnection(result.data);
        }
      } catch (error) {
        toast.error(`Failed to save connection: ${error}`);
        return { success: false };
      } finally {
        setLoading(false);
      }
    },
    [initiateConnection],
  );

  /**
   * Handle password authentication submission
   */
  const handlePasswordSubmit = useCallback(
    async (password: string, savePassword: boolean) => {
      if (connectionId === null) {
        toast.error("No connection ID available");
        return;
      }

      setLoading(true);
      try {
        await commands.connectSshWithPassword(connectionId, password, savePassword);
        setShowPasswordModal(false);

        // Fetch fresh connection data and call callback
        // (getConnectionById also updates state, so no separate reload needed)
        const connection = await getConnectionById(connectionId);
        if (connection) {
          onConnectionSuccess(connection);
        } else {
          toast.error("Failed to retrieve connection details");
        }
      } catch (error) {
        toast.error(`Authentication failed: ${error}`);
      } finally {
        setLoading(false);
      }
    },
    [connectionId, onConnectionSuccess, getConnectionById],
  );

  /**
   * Handle password modal cancellation
   */
  const handlePasswordCancel = useCallback(() => {
    setShowPasswordModal(false);
  }, []);

  return {
    connections,
    showPasswordModal,
    loading,
    handleConnection,
    handleNewConnection,
    handlePasswordSubmit,
    handlePasswordCancel,
    refetchConnections, // Export for manual refetch if needed
  };
}
