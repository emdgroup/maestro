import { useState, useRef, useEffect } from "react";
import type { SshConnection } from "@/types/bindings";
import { Connection, localConnectionId } from "@/contexts/ConnectionContext";
import {
  useSshConnections,
  useConnectSsh,
  useConnectSshWithAgent,
  useConnectSshWithCreds,
  useConnectSshWithKey,
  useCreateSshConnection,
  useDeleteSshConnection,
} from "@/services/connection.service";
import type { AuthSubmission } from "@/components/project-picker/SshAuthModal";

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
  const [username, setUsername] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState<number | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isNewConnection, setIsNewConnection] = useState(false);
  const { data: sshConnections = [], refetch: refetchConnections } = useSshConnections();

  // Service mutation hooks for SSH operations
  const { mutate: connectSsh } = useConnectSsh();
  const { mutate: connectSshWithAgent } = useConnectSshWithAgent();
  const { mutate: createSshConnection } = useCreateSshConnection();
  const { mutate: connectSshWithCreds } = useConnectSshWithCreds();
  const { mutate: connectSshWithKey } = useConnectSshWithKey();
  const { mutate: deleteSshConnection } = useDeleteSshConnection();

  const local = useRef<Connection>({
    type: "local" as const,
    id: localConnectionId,
    displayName: "Local",
    subtitle: "Browse local filesystem",
  });

  const buildConnection = (sshConn: SshConnection) => ({
    type: "ssh" as const,
    id: sshConn.id,
    displayName: sshConn.display_name || sshConn.connection_string,
    subtitle: sshConn.display_name ? sshConn.connection_string : undefined,
    metadata: `Last used: ${new Date(sshConn.last_used_at).toLocaleDateString()}`,
    sshConnection: sshConn,
  });

  useEffect(() => {
    setConnections([local.current, ...sshConnections.map(buildConnection)]);
  }, [sshConnections, buildConnection]);

  const keyMap = new Map<string, boolean>();
  for (const conn of sshConnections) {
    const method = conn.auth_method;
    if (typeof method === "object" && "KeyFile" in method) {
      const { path, save_passphrase } = method.KeyFile;
      keyMap.set(path, (keyMap.get(path) ?? false) || save_passphrase);
    }
  }
  const savedKeyFiles = Array.from(keyMap.entries()).map(([path, hasSavedPassphrase]) => ({
    path,
    hasSavedPassphrase,
  }));

  const getConnectionById = async (id: number): Promise<Connection | null> => {
    try {
      // Refetch to ensure we have the latest data (TanStack Query will update cache)
      const { data } = await refetchConnections();

      const sshConn = data?.find((conn) => conn.id === id);
      return sshConn ? buildConnection(sshConn) : null;
    } catch (error) {
      console.error("Failed to get connection:", error);
      return null;
    }
  };

  const initiateConnection = async (connId: number) => {
    setLoading(true);
    setConnectionId(connId);
    connectSsh(
      { connectionId: connId },
      {
        onSuccess: async () => {
          const connection = await getConnectionById(connId);
          if (connection) {
            onConnectionSuccess(connection);
          }
        },
        onError: () => setShowAuthModal(true),
        onSettled: () => setLoading(false),
      },
    );
  };

  const handleConnection = async (connection: Connection) => {
    setIsNewConnection(false);
    setUsername(connection.sshConnection?.username ?? "");
    if (connection.type === "local") {
      onConnectionSuccess(local.current);
    } else if (connection.sshConnection) {
      await initiateConnection(connection.sshConnection.id);
    }
  };

  const handleNewConnection = async (connectionString: string) => {
    setLoading(true);
    setIsNewConnection(true);
    setUsername(connectionString.split("@")[0]);
    createSshConnection(
      {
        connectionString,
        authMethod: "Agent", // Default to Agent auth
      },
      {
        onSuccess: async (connectionIdResult) => {
          await initiateConnection(connectionIdResult);
        },
        onSettled: () => setLoading(false),
      },
    );
  };

  const handleAuthSubmit = async (auth: AuthSubmission) => {
    if (connectionId === null) return;
    const options = {
      onSuccess: async () => {
        const connection = await getConnectionById(connectionId);
        if (connection) onConnectionSuccess(connection);
        setShowAuthModal(false);
      },
      onSettled: () => {
        setLoading(false);
      },
    };

    setLoading(true);

    if (auth.method === "password") {
      connectSshWithCreds(
        {
          connectionId,
          password: auth.password,
          savePassword: auth.savePassword,
        },
        { ...options },
      );
    } else if (auth.method === "key-file") {
      connectSshWithKey(
        {
          connectionId,
          keyPath: auth.keyPath,
          passphrase: auth.passphrase,
          savePassphrase: auth.savePassphrase,
        },
        { ...options },
      );
    } else {
      // agent — use dedicated agent auth handler
      connectSshWithAgent({ connectionId }, { ...options });
    }
  };

  const handleAuthCancel = () => {
    if (isNewConnection && !!connectionId) {
      void deleteSshConnection(connectionId);
    }
    setShowAuthModal(false);
  };

  return {
    username,
    connections,
    savedKeyFiles,
    showAuthModal,
    loading,
    handleConnection,
    handleNewConnection,
    handleAuthSubmit,
    handleAuthCancel,
    refetchConnections, // Export for manual refetch if needed
  };
}
