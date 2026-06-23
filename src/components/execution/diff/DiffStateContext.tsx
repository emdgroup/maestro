import { createContext, useContext } from "react";

export interface DiffStateContextValue {
  viewMode: "uncommitted" | "untracked";
  setViewMode: (m: "uncommitted" | "untracked") => void;
  selectedFileIndex: number | null;
  setSelectedFileIndex: (i: number | null) => void;
  fileListMode: "flat" | "tree";
  setFileListMode: (m: "flat" | "tree") => void;
}

const DiffStateContext = createContext<DiffStateContextValue | null>(null);

export function useDiffState(): DiffStateContextValue {
  const ctx = useContext(DiffStateContext);
  if (!ctx) throw new Error("useDiffState must be used inside DiffStateProvider");
  return ctx;
}

interface DiffStateProviderProps extends DiffStateContextValue {
  children: React.ReactNode;
}

export function DiffStateProvider({ children, ...value }: DiffStateProviderProps) {
  return <DiffStateContext.Provider value={value}>{children}</DiffStateContext.Provider>;
}
