import { useState, useRef, useMemo, useCallback } from "react";
import type {
  SshConnection,
  WslConnection,
  DockerConnection,
  SshAuthMethod,
} from "@/types/bindings";
import { Connection, localConnectionId } from "@/contexts/ConnectionContext";
import {
  useSshConnections,
  useConnectSsh,
  useConnectSshWithAgent,
  useConnectSshWithCreds,
  useConnectSshWithKey,
  useCreateSshConnection,
  useDeleteSshConnection,
  useWslDistros,
  useWslConnections,
  useSaveWslConnection,
  useDockerConnections,
} from "@/services/connection.service";
import type { AuthSubmission } from "@/views/project-picker/ssh-auth-modal/SshAuthModal";

interface connectionManagerProps {
  onConnectionSuccess: (connection: Connection) => void;
}

function toSshAuthMethod(auth: AuthSubmission): SshAuthMethod {
  if (auth.method === "password") return { Password: { save_password: auth.savePassword } };
  if (auth.method === "key-file")
    return { KeyFile: { path: auth.keyPath, save_passphrase: auth.savePassphrase } };
  return "Agent";
}

export function useConnectionManager({ onConnectionSuccess }: connectionManagerProps) {
  const [username, setUsername] = useState("");
  const [connectionId, setConnectionId] = useState<number | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isNewConnection, setIsNewConnection] = useState(false);
  const [pendingConnectionString, setPendingConnectionString] = useState<string | null>(null);
  const { data: sshConnections = [], refetch: refetchConnections } = useSshConnections();
  const { data: wslDistros = [] } = useWslDistros();
  const { data: wslConnections = [] } = useWslConnections();
  const { mutateAsync: saveWslConnection } = useSaveWslConnection();
  const { data: dockerConnections = [] } = useDockerConnections();

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

  const buildConnection = useCallback(
    (sshConn: SshConnection): Connection => ({
      type: "ssh" as const,
      id: sshConn.id,
      displayName: sshConn.display_name || sshConn.connection_string,
      subtitle: sshConn.display_name ? sshConn.connection_string : undefined,
      metadata: `Last used: ${new Date(sshConn.last_used_at).toLocaleDateString()}`,
      sshConnection: sshConn,
    }),
    [],
  );

  const buildWslConnection = useCallback(
    (distroName: string, savedConn: WslConnection | undefined): Connection => ({
      type: "wsl" as const,
      id: `wsl-${distroName}`,
      displayName: distroName,
      subtitle: "WSL",
      wslConnection: savedConn,
    }),
    [],
  );

  const buildDockerConnection = useCallback(
    (dockerConn: DockerConnection): Connection => ({
      type: "docker" as const,
      id: `docker-${dockerConn.id}`,
      displayName: dockerConn.display_name ?? dockerConn.container_name,
      subtitle: dockerConn.image_name ?? dockerConn.container_name,
      dockerConnection: dockerConn,
    }),
    [],
  );

  const connections = useMemo(() => {
    const wslItems = wslDistros
      .filter((distro) => wslConnections.some((c) => c.distro_name === distro.name))
      .map((distro) => {
        const saved = wslConnections.find((c) => c.distro_name === distro.name)!;
        return buildWslConnection(distro.name, saved);
      });
    const dockerItems = dockerConnections.map(buildDockerConnection);
    return [local.current, ...wslItems, ...dockerItems, ...sshConnections.map(buildConnection)];
  }, [
    sshConnections,
    wslDistros,
    wslConnections,
    dockerConnections,
    buildConnection,
    buildWslConnection,
    buildDockerConnection,
  ]);

  const savedKeyFiles = useMemo(() => {
    const keyMap = new Map<string, boolean>();
    for (const conn of sshConnections) {
      const method = conn.auth_method;
      if (typeof method === "object" && "KeyFile" in method) {
        const { path, save_passphrase } = method.KeyFile;
        keyMap.set(path, (keyMap.get(path) ?? false) || save_passphrase);
      }
    }
    return Array.from(keyMap.entries()).map(([path, hasSavedPassphrase]) => ({
      path,
      hasSavedPassphrase,
    }));
  }, [sshConnections]);

  const getConnectionById = async (id: number): Promise<Connection | null> => {
    try {
      const { data } = await refetchConnections();
      const sshConn = data?.find((conn) => conn.id === id);
      return sshConn ? buildConnection(sshConn) : null;
    } catch (error) {
      console.error("Failed to get connection:", error);
      return null;
    }
  };

  // Used for reconnecting to existing saved connections.
  const initiateConnection = async (connId: number) => {
    setLoading(true);
    setConnectionId(connId);
    connectSsh(
      { connectionId: connId },
      {
        onSuccess: async () => {
          const connection = await getConnectionById(connId);
          if (connection) onConnectionSuccess(connection);
        },
        onError: () => setShowAuthModal(true),
        onSettled: () => setLoading(false),
      },
    );
  };

  // Shared connect-with-method logic for both paths.
  // isNew=true: delete record on connect failure (new connection rollback).
  // isNew=false: keep record on failure (reconnect to existing connection).
  const connectWithAuth = (connId: number, auth: AuthSubmission, isNew: boolean) => {
    const options = {
      onSuccess: async () => {
        const connection = await getConnectionById(connId);
        if (connection) onConnectionSuccess(connection);
        setShowAuthModal(false);
        setIsNewConnection(false);
        setPendingConnectionString(null);
      },
      onError: () => {
        if (isNew) {
          deleteSshConnection(connId);
          setConnectionId(null);
          // Keep modal open — user can retry with a different method.
        }
      },
      onSettled: () => setLoading(false),
    };

    if (auth.method === "password") {
      connectSshWithCreds(
        { connectionId: connId, password: auth.password, savePassword: auth.savePassword },
        options,
      );
    } else if (auth.method === "key-file") {
      connectSshWithKey(
        {
          connectionId: connId,
          keyPath: auth.keyPath,
          passphrase: auth.passphrase,
          savePassphrase: auth.savePassphrase,
        },
        options,
      );
    } else {
      connectSshWithAgent({ connectionId: connId }, options);
    }
  };

  const handleConnection = async (connection: Connection) => {
    setIsNewConnection(false);
    setUsername(connection.sshConnection?.username ?? "");
    if (connection.type === "local") {
      onConnectionSuccess(local.current);
    } else if (connection.type === "docker") {
      onConnectionSuccess(connection);
    } else if (connection.type === "wsl") {
      setLoading(true);
      try {
        const saved =
          connection.wslConnection ??
          (await saveWslConnection({ distroName: connection.displayName, displayName: null }));
        const wslConn: Connection = { ...connection, wslConnection: saved };
        onConnectionSuccess(wslConn);
      } finally {
        setLoading(false);
      }
    } else if (connection.sshConnection) {
      await initiateConnection(connection.sshConnection.id);
    }
  };

  // Try SSH agent silently first. Modal only appears if agent auth fails.
  // This way agent users get a transparent connection experience.
  const handleNewConnection = (connectionString: string) => {
    setIsNewConnection(true);
    setUsername(connectionString.split("@")[0]);
    setPendingConnectionString(connectionString);
    setConnectionId(null);
    setLoading(true);

    createSshConnection(
      { connectionString, authMethod: "Agent" },
      {
        onSuccess: (connId) => {
          setConnectionId(connId);
          connectSsh(
            { connectionId: connId },
            {
              onSuccess: async () => {
                const conn = await getConnectionById(connId);
                if (conn) onConnectionSuccess(conn);
                setIsNewConnection(false);
                setPendingConnectionString(null);
              },
              onError: () => setShowAuthModal(true),
              onSettled: () => setLoading(false),
            },
          );
        },
        onError: () => setLoading(false),
      },
    );
  };

  const handleAuthSubmit = async (auth: AuthSubmission) => {
    if (isNewConnection) {
      setLoading(true);
      if (connectionId !== null) {
        // Record exists from the agent attempt — connect with the chosen method.
        connectWithAuth(connectionId, auth, true);
      } else if (pendingConnectionString !== null) {
        // Previous connect attempt failed and rolled back the record — re-create.
        createSshConnection(
          { connectionString: pendingConnectionString, authMethod: toSshAuthMethod(auth) },
          {
            onSuccess: (connId) => {
              setConnectionId(connId);
              connectWithAuth(connId, auth, true);
            },
            onError: () => setLoading(false),
          },
        );
      }
      return;
    }

    // Reconnect path: record already exists, just re-authenticate. Never delete.
    if (connectionId === null) return;
    setLoading(true);
    connectWithAuth(connectionId, auth, false);
  };

  const handleAuthCancel = () => {
    if (isNewConnection && connectionId !== null) {
      void deleteSshConnection(connectionId);
    }
    setShowAuthModal(false);
    setIsNewConnection(false);
    setPendingConnectionString(null);
    setConnectionId(null);
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
    refetchConnections,
  };
}
