import { useState } from "react";
import {
  useGetDefaultFilePickerPath,
  useListDrives,
  useSshHome,
} from "@/services/connection.service";
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
  const sshHomeQuery = useSshHome(isLocal ? null : connection?.id);

  // The root is the fallback when the home folder cannot be read: it lists on every OS.
  const sshHome = sshHomeQuery.data ?? (sshHomeQuery.isError ? "/" : "");
  const initialPath = isLocal ? (getDefaultPathQuery.data ?? "/") : connection ? sshHome : "";

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
