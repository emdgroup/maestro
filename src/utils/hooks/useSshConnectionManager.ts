import { useState, useCallback, useRef, useEffect } from "react";
import type { SshConnection } from "@/types/bindings.ts";
import { Connection, localConnectionId } from "@/contexts/ConnectionContext.tsx";
import {
  useSshConnections,
  useConnectSsh,
  useConnectSshWithCreds,
  useCreateSshConnection,
} from "@/services/connection.service.ts";

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

  // Service mutation hooks for SSH operations
  const {mutate: connectSsh} = useConnectSsh();
  const {mutate: createSshConnection} = useCreateSshConnection();
  const {mutate: connectSshWithCreds} = useConnectSshWithCreds();

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
      connectSsh({ connectionId: connId }, {
        onSuccess: async () => {
          const connection = await getConnectionById(connId);
          if (connection) {
            onConnectionSuccess(connection);
          }
        },
        onError: () => setShowPasswordModal(true),
        onSettled: () => setLoading(false)
      })
    },
    [onConnectionSuccess, getConnectionById, connectSsh],
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
      setLoading(true);
      createSshConnection({
        connectionString,
        authMethod: "Agent", // Default to Agent auth
      }, {
        onSuccess: async (connectionIdResult) => {
          await initiateConnection(connectionIdResult);
        },
        onSettled: () => setLoading(false)
      });
    },
    [initiateConnection, createSshConnection],
  );

  /**
   * Handle password authentication submission
   */
  const handlePasswordSubmit = useCallback(
    async (password: string, savePassword: boolean) => {
      if (connectionId === null) {
        // Error shown by service layer
        return;
      }

      setLoading(true);
      connectSshWithCreds({
        connectionId,
        password,
        savePassword,
      }, {
        onSuccess: async () => {
          const connection = await getConnectionById(connectionId);
          if (connection) {
            onConnectionSuccess(connection);
          }
        },
        onSettled: () => {
          setShowPasswordModal(false);
          setLoading(false);
        }
      });
    },
    [connectionId, onConnectionSuccess, getConnectionById, connectSshWithCreds],
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
