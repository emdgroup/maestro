import { createContext, useContext, useState, ReactNode } from "react";
import type { SshConnection } from "@/types";

type View = "connections" | "projects";

type ConnectionType = "local" | "ssh";

export interface Connection {
  type: ConnectionType;
  id: string | number;
  displayName: string;
  subtitle?: string;
  metadata?: string;
  sshConnection?: SshConnection;
}

interface ConnectionContextValue {
  activeConnection: Connection | null;
  setActiveConnection: (connection: Connection | null) => void;
  view: View;
  setView: (view: View) => void;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

interface ConnectionProviderProps {
  children: ReactNode;
}

/**
 * Provider for managing the active connection state within the ProjectPicker subtree.
 *
 * This eliminates prop drilling by making activeConnection available to any
 * component within the provider via useConnectionContext hook.
 */
export function ConnectionProvider({ children }: ConnectionProviderProps) {
  const [activeConnection, setActiveConnection] = useState<Connection | null>(null);
  const [view, setView] = useState<View>("connections");

  return (
    <ConnectionContext.Provider value={{ activeConnection, setActiveConnection, view, setView }}>
      {children}
    </ConnectionContext.Provider>
  );
}

/**
 * Hook to access the active connection state.
 * Must be used within a ConnectionProvider.
 */
export function useConnectionContext() {
  const context = useContext(ConnectionContext);
  if (!context) {
    throw new Error("useConnectionContext must be used within a ConnectionProvider");
  }
  return context;
}

export const localConnectionId = "local";
