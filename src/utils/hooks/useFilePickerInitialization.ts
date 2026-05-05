import { useState } from "react";
import { useGetDefaultFilePickerPath, useListDrives } from "@/services/connection.service";
import type { SshConnection } from "@/types/bindings";

interface UseFilePickerInitializationReturn {
  isInitialized: boolean;
  initialPath: string;
  drives: string[];
  showHidden: boolean;
  setShowHidden: (show: boolean) => void;
  isLoading: boolean;
}

export function useFilePickerInitialization(
  isLocal: boolean,
  connection?: SshConnection | null,
): UseFilePickerInitializationReturn {
  const [showHidden, setShowHidden] = useState(false);

  // Service hooks for initialization
  const getDefaultPathQuery = useGetDefaultFilePickerPath();
  const listDrivesQuery = useListDrives();

  const initialPath = isLocal
    ? (getDefaultPathQuery.data ?? "/")
    : connection
      ? `/home/${connection.username}`
      : "";

  const drives = isLocal && listDrivesQuery.data ? listDrivesQuery.data : [];

  // Initialization is complete when queries have finished loading
  const isInitialized = !getDefaultPathQuery.isLoading && !listDrivesQuery.isLoading;
  const isLoading = getDefaultPathQuery.isLoading || listDrivesQuery.isLoading;

  return {
    isInitialized,
    initialPath,
    drives,
    showHidden,
    setShowHidden,
    isLoading,
  };
}
