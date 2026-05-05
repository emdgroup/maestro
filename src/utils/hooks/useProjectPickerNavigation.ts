import { useCallback, useEffect } from "react";
import { Connection, useConnectionContext } from "@/contexts/ConnectionContext";

/**
 * Custom hook for managing ProjectPicker navigation state.
 *
 * Centralized ownership of view state and active connection.
 * Provides clear navigation methods instead of scattered state updates.
 *
 * @returns navigation methods
 */
export function useProjectPickerNavigation() {
  const { activeConnection, setActiveConnection, setView } = useConnectionContext();

  useEffect(() => {
    if (activeConnection) {
      setView("projects");
    } else {
      setView("connections");
    }
  }, [activeConnection, setView]);

  /**
   * Navigate to projects view for the given connection
   */
  const navigateToProjects = useCallback(
    (connection: Connection) => {
      setActiveConnection(connection);
    },
    [setActiveConnection],
  );

  /**
   * Navigate back to connections list and clear active connection
   */
  const navigateToConnections = useCallback(() => {
    setActiveConnection(null);
  }, [setActiveConnection]);

  return {
    navigateToProjects,
    navigateToConnections,
  };
}
