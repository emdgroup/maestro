import { createContext, useContext, useMemo, ReactNode } from "react";
import type { ConnectionKey, Task } from "@/types/bindings";

interface KanbanContextValue {
  projectId: number;
  projectPath: string;
  connection: ConnectionKey;
  onTaskClick: (task: Task) => void;
}

const KanbanContext = createContext<KanbanContextValue | null>(null);

interface KanbanProviderProps {
  children: ReactNode;
  projectId: number;
  projectPath: string;
  connection: ConnectionKey;
  onTaskClick: (task: Task) => void;
}

export function KanbanProvider({
  children,
  projectId,
  projectPath,
  connection,
  onTaskClick,
}: KanbanProviderProps) {
  // Memoized because this provider sits under `App`: a fresh object literal here would make every
  // App render a context change, and so a re-render of every card on the board.
  const value = useMemo(
    () => ({ projectId, projectPath, connection, onTaskClick }),
    [projectId, projectPath, connection, onTaskClick],
  );

  return <KanbanContext.Provider value={value}>{children}</KanbanContext.Provider>;
}

export function useKanban() {
  const context = useContext(KanbanContext);
  if (!context) {
    throw new Error("useKanban must be used within KanbanProvider");
  }
  return context;
}
