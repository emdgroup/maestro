import { useCallback, useEffect, useState } from "react";
import { useRecentProjects } from "../hooks/useRecentProjects";
import { useSshConnectionManager } from "../hooks/useSshConnectionManager";
import { Connection } from "@/components/ConnectionList.tsx";

interface Params {
  setShowFilePickerModal: (v: boolean) => void;
}
type View = "connections" | "projects";

export function useProjectPickerManager({ setShowFilePickerModal }: Params) {
  const [currentView, setCurrentView] = useState<View>("connections");
  // Initialize custom hooks
  const {
    activeConnection,
    connections,
    showPasswordModal,
    loading: sshLoading,
    setActiveConnection,
    handleConnection: handleSshConnection,
    handleNewConnection: handleNewSshConnection,
    handlePasswordSubmit: handleSshPasswordSubmit,
    handleRemoveConnection: handleRemoveSshConnection,
    handleForgetPassword: handleForgetSshPassword,
    handlePasswordCancel,
    loadSshConnections,
  } = useSshConnectionManager();
  // Load enhanced recent projects with metadata, filtered by active connection
  const connectionId = activeConnection?.type === "ssh" && typeof activeConnection.id === "number"
    ? activeConnection.id
    : null;
  const {
    recentProjects,
    loading: recentLoading,
    refetch: refetchRecentProjects,
  } = useRecentProjects(connectionId);

  /**
   * Handle local "Select New Project" button click
   * Opens file picker modal for local filesystem
   */
  const handleSelectNewLocal = useCallback(() => {
    console.log("Opening local file picker");
    setShowFilePickerModal(true);
  }, [setShowFilePickerModal]);

  /**
   * Handle back button click from projects view
   * Returns to connections view and clears active connection
   */
  const handleBackToConnections = () => {
    setActiveConnection(null);
  };

  useEffect(() => {
    if (activeConnection === null) {
      setCurrentView("connections");
    }
  }, [activeConnection, setCurrentView]);

  /**
   * Handle remote "Select New Project" button click
   * Attempts authentication before showing file picker
   * If auth fails, shows password modal
   */
  const handleRemoteSelectProject = useCallback(async () => {
    if (!activeConnection?.sshConnection) return;
    setShowFilePickerModal(true);
  }, [activeConnection, setShowFilePickerModal]);

  const handleConnection = async (connection: Connection) => {
    setActiveConnection(connection);
    if (connection.type === "ssh") {
      // For SSH connection try to connect first
      await handleSshConnection(connection);
    }
    setCurrentView("projects");
  };

  // Handle new connection with view navigation coordination
  const handleNewConnection = async (connectionString: string) => {
    const result = await handleNewSshConnection(connectionString);
    if (result?.success) {
      setCurrentView("projects");
    }
  };

  // Handle password submit with view navigation coordination
  const handlePasswordSubmit = async (password: string, savePassword: boolean) => {
    const result = await handleSshPasswordSubmit(password, savePassword);
    if (result?.success) {
      setCurrentView("projects");
    }
  };

  const handleRemoveConnection = async () => {
    const result = await handleRemoveSshConnection();
    if (result?.success) {
      setCurrentView("connections");
    }
  };

  const handleForgetPassword = async () => {
    const result = await handleForgetSshPassword();
    if (result?.success) {
      setCurrentView("connections");
    }
  };

  // Combined loading state for UI
  const isLoading = sshLoading || recentLoading;

  return {
    currentView,
    recentProjects,
    activeConnection,
    connections,
    showPasswordModal,
    isLoading,
    refetchRecentProjects,
    handleConnection,
    handleNewConnection,
    handleBackToConnections,
    handleRemoteSelectProject,
    handlePasswordSubmit,
    handleSelectNewLocal,
    handleRemoveConnection,
    handleForgetPassword,
    handlePasswordCancel,
    loadSshConnections,
  };
}
