import { useState, useCallback } from "react";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";
import { Connection } from "../components/ConnectionList";

type View = "connections" | "projects";

interface UseViewNavigationParams {
  activeConnection: Connection | null;
  setActiveConnection: (conn: Connection | null) => void;
  setShowPasswordModal: (show: boolean) => void;
  setLoading: (loading: boolean) => void;
}

/**
 * Custom hook for managing view navigation and modal state.
 *
 * Handles:
 * - View state management (connections vs projects)
 * - Connection selection and routing
 * - File picker modal visibility
 * - Remote project selection flow (auth + file picker)
 *
 * @param params - Configuration parameters including state setters from SSH manager
 * @returns View navigation state and handlers
 */
export function useViewNavigation({
  activeConnection,
  setActiveConnection,
  setShowPasswordModal,
  setLoading,
}: UseViewNavigationParams) {
  const [currentView, setCurrentView] = useState<View>("connections");
  const [showFilePickerModal, setShowFilePickerModal] = useState(false);

  /**
   * Handle local "Select New Project" button click
   * Opens file picker modal for local filesystem
   */
  const handleSelectNewLocal = useCallback(() => {
    console.log("Opening local file picker");
    setShowFilePickerModal(true);
  }, []);

  /**
   * Handle connection selection from ConnectionList
   * Routes to projects view for both local and SSH connections
   */
  const handleConnectionClick = useCallback(
    (connection: Connection) => {
      if (connection.type === "local") {
        // For local connection, navigate to projects view
        console.log("Local connection selected");
        setActiveConnection(connection);
        setCurrentView("projects");
      } else {
        // For SSH connection, navigate to projects view
        console.log(`Selected SSH connection: ${connection.displayName}`);
        setActiveConnection(connection);
        setCurrentView("projects");
      }
    },
    [setActiveConnection]
  );

  /**
   * Handle back button click from projects view
   * Returns to connections view and clears active connection
   */
  const handleBackToConnections = useCallback(() => {
    setCurrentView("connections");
    setActiveConnection(null);
  }, [setActiveConnection]);

  /**
   * Handle remote "Select New Project" button click
   * Attempts authentication before showing file picker
   * If auth fails, shows password modal
   */
  const handleRemoteSelectProject = useCallback(async () => {
    if (!activeConnection || !activeConnection.sshConnection) return;

    const sshConn = activeConnection.sshConnection;
    console.log(`Opening remote file picker for: ${sshConn.connection_string}`);
    setLoading(true);

    try {
      // Try connecting without credentials first
      await safeInvoke("connect_ssh_without_credentials", {
        connectionId: sshConn.id,
      });

      toast.success(`Connected to ${sshConn.connection_string}`);

      // Show file picker modal
      setShowFilePickerModal(true);
    } catch (error) {
      console.log("Credential-less connection failed, showing password modal");
      // Show password modal on auth failure
      setShowPasswordModal(true);
    } finally {
      setLoading(false);
    }
  }, [activeConnection, setLoading, setShowPasswordModal]);

  return {
    currentView,
    showFilePickerModal,
    setShowFilePickerModal,
    setCurrentView,
    handleConnectionClick,
    handleBackToConnections,
    handleSelectNewLocal,
    handleRemoteSelectProject,
  };
}
