import { useState, useEffect } from "react";
import { useGetDefaultFilePickerPath, useListDrives } from "@/services";
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
  const [isInitialized, setIsInitialized] = useState(false);
  const [initialPath, setInitialPath] = useState<string>("");
  const [drives, setDrives] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);

  // Service hooks for initialization
  const getDefaultPathQuery = useGetDefaultFilePickerPath();
  const listDrivesQuery = useListDrives();

  // Initialize default path on mount
  useEffect(() => {
    async function initializePath() {
      if (isLocal && !isInitialized) {
        try {
          const data = getDefaultPathQuery.data;
          if (data) {
            setInitialPath(data);
            setIsInitialized(true);
          } else if (getDefaultPathQuery.isSuccess) {
            setInitialPath("/");
            setIsInitialized(true);
          }
        } catch (error) {
          console.error("Failed to get default path:", error);
          setInitialPath("/");
          setIsInitialized(true);
        }
      } else if (!isLocal && !isInitialized && connection) {
        // For remote connections, use /home/username
        const remotePath = `/home/${connection.username}`;
        setInitialPath(remotePath);
        setIsInitialized(true);
      }
    }

    void initializePath();
  }, [isLocal, isInitialized, connection, getDefaultPathQuery.data, getDefaultPathQuery.isSuccess]);

  // Load drives on Windows (local only)
  useEffect(() => {
    if (isLocal && listDrivesQuery.data) {
      setDrives(listDrivesQuery.data);
    }
  }, [isLocal, listDrivesQuery.data]);

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
