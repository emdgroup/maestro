import { createContext, useCallback, useContext, useState, ReactNode } from "react";
import type { ConnectionKey, SshConnection, WslConnection, PreflightResult } from "@/types/bindings";
import { commands } from "@/types/bindings";
import { useConfigStore } from "@/store/configStore";

type View = "connections" | "projects";

type ConnectionType = "local" | "ssh" | "wsl";

export type PreflightStatus = "idle" | "checking" | "passed" | "failed" | "failed-ignored";

export interface Connection {
  type: ConnectionType;
  id: string | number;
  displayName: string;
  subtitle?: string;
  metadata?: string;
  sshConnection?: SshConnection;
  wslConnection?: WslConnection;
}

interface ConnectionContextValue {
  activeConnection: Connection | null;
  setActiveConnection: (connection: Connection | null) => void;
  view: View;
  setView: (view: View) => void;
  preflightStatus: PreflightStatus;
  preflightResult: PreflightResult | null;
  preflightError: string | null;
  startPreflight: (connection: Connection) => Promise<void>;
  ignoreWarnings: () => void;
  resetPreflight: () => void;
}

export const ConnectionContext = createContext<ConnectionContextValue | null>(null);

interface ConnectionProviderProps {
  children: ReactNode;
}

export function ConnectionProvider({ children }: ConnectionProviderProps) {
  const [activeConnection, setActiveConnection] = useState<Connection | null>(null);
  const [view, setView] = useState<View>("connections");
  const [preflightStatus, setPreflightStatus] = useState<PreflightStatus>("idle");
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);

  const startPreflight = useCallback(
    async (connection: Connection) => {
      if (preflightStatus === "checking") return;

      const connectionKey: ConnectionKey =
        connection.type === "wsl" && connection.wslConnection
          ? { type: "wsl", id: connection.wslConnection.id }
          : connection.type === "ssh" && connection.sshConnection
            ? { type: "ssh", id: connection.sshConnection.id }
            : { type: "local" };

      setPreflightStatus("checking");
      setPreflightResult(null);
      setPreflightError(null);

      const response = await commands.preflightConnection(connectionKey);
      if (response.status === "error") {
        setPreflightError(response.error as string);
        setPreflightStatus("failed");
        return;
      }

      const result = response.data;
      useConfigStore.getState().setPreflightToolChecks(connectionKey, result.tool_checks);
      setPreflightResult(result);

      const hasIssues = !result.maestro_server.ok || result.tool_checks.some((t) => !t.available);
      setPreflightStatus(hasIssues ? "failed" : "passed");
    },
    [preflightStatus],
  );

  const ignoreWarnings = useCallback(() => {
    setPreflightStatus("failed-ignored");
  }, []);

  const resetPreflight = useCallback(() => {
    setPreflightStatus("idle");
    setPreflightResult(null);
    setPreflightError(null);
    setActiveConnection(null);
    setView("connections");
  }, []);

  return (
    <ConnectionContext.Provider
      value={{
        activeConnection,
        setActiveConnection,
        view,
        setView,
        preflightStatus,
        preflightResult,
        preflightError,
        startPreflight,
        ignoreWarnings,
        resetPreflight,
      }}
    >
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnectionContext() {
  const context = useContext(ConnectionContext);
  if (!context) {
    throw new Error("useConnectionContext must be used within a ConnectionProvider");
  }
  return context;
}

export const localConnectionId = "local";
