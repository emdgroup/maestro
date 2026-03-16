import { createContext, useContext, ReactNode } from "react";
import type { Task } from "@/types/bindings";

interface KanbanContextValue {
  projectId: number;
  projectPath: string;
  onTaskClick: (task: Task) => void;
}

const KanbanContext = createContext<KanbanContextValue | null>(null);

interface KanbanProviderProps {
  children: ReactNode;
  projectId: number;
  projectPath: string;
  onTaskClick: (task: Task) => void;
}

export function KanbanProvider({
  children,
  projectId,
  projectPath,
  onTaskClick
}: KanbanProviderProps) {
  return (
    <KanbanContext.Provider value={{ projectId, projectPath, onTaskClick }}>
      {children}
    </KanbanContext.Provider>
  );
}

export function useKanban() {
  const context = useContext(KanbanContext);
  if (!context) {
    throw new Error("useKanban must be used within KanbanProvider");
  }
  return context;
}
