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
  const { setActiveConnection, setView } = useConnectionContext();

  const navigateToProjects = (connection: Connection) => {
    setActiveConnection(connection);
    setView("projects");
  };

  const navigateToConnections = () => {
    setActiveConnection(null);
    setView("connections");
  };

  return {
    navigateToProjects,
    navigateToConnections,
  };
}
