import { useMemo } from "react";
import { ConnectionList } from "./ConnectionList";
import { LocalProjectsList } from "./LocalProjectsList";
import { RemoteProjectsList } from "./RemoteProjectsList";
import { PasswordModal } from "./PasswordModal";
import { FilePicker } from "./FilePicker";
import { Dialog, DialogContent } from "./ui/dialog";
import { useRecentProjects } from "../hooks/useRecentProjects";
import { useSshConnectionManager } from "../hooks/useSshConnectionManager";
import { useProjectSelection } from "../hooks/useProjectSelection";
import { useViewNavigation } from "../hooks/useViewNavigation";
import { ThemeToggle } from "./ThemeToggle";

interface ProjectPickerProps {
  onProjectSelected: (path: string) => void;
  onRecentProjectsChanged?: () => void;
}

export function ProjectPicker({
  onProjectSelected,
  onRecentProjectsChanged,
}: ProjectPickerProps) {
  // Load enhanced recent projects with metadata
  const { recentProjects, loading: recentLoading, refetch: refetchRecentProjects } = useRecentProjects();

  // Initialize custom hooks
  const sshManager = useSshConnectionManager();

  const viewNav = useViewNavigation({
    activeConnection: sshManager.activeConnection,
    setActiveConnection: sshManager.setActiveConnection,
    setShowPasswordModal: sshManager.setShowPasswordModal,
    setLoading: () => {
      // Loading state is managed by individual hooks (sshManager, projectSelection)
      // No need for additional state management here
    },
  });

  const projectSelection = useProjectSelection({
    activeConnection: sshManager.activeConnection,
    onProjectSelected,
    onRecentProjectsChanged,
    refetchRecentProjects,
  });

  // Sort recent projects by last_opened (most recent first)
  const sortedRecentProjects = useMemo(() => {
    return [...recentProjects].sort((a, b) => {
      // Sort descending (most recent first)
      return b.last_opened.localeCompare(a.last_opened);
    });
  }, [recentProjects]);

  // Handle new connection with view navigation coordination
  const handleNewConnection = async (connectionString: string) => {
    const result = await sshManager.handleNewConnection(connectionString);
    if (result?.success) {
      viewNav.setCurrentView("projects");
    }
  };

  // Handle password submit with view navigation coordination
  const handlePasswordSubmit = async (password: string, savePassword: boolean) => {
    const result = await sshManager.handlePasswordSubmit(password, savePassword);
    if (result?.success) {
      viewNav.setCurrentView("projects");
      viewNav.setShowFilePickerModal(true);
    }
  };


  // Combined loading state for UI
  const isLoading = sshManager.loading || projectSelection.loading || recentLoading;

  // Main screen with unified connection list
  return (
    <>
      <div className="flex items-center justify-center min-h-screen bg-background text-foreground p-8 relative">
        {/* Theme Toggle - Top Right */}
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>

        <div className="max-w-3xl w-full">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-semibold mb-3">
              Agent Orchestrator
            </h1>
            <p className="text-base text-muted-foreground">
              Select a connection to get started
            </p>
          </div>

          {/* Single Panel with Slide Transition */}
          <div className="bg-card border border-border rounded-lg overflow-clip relative min-h-[500px] max-h-[700px]">
            {/* Connections View */}
            <div
              className={`absolute inset-0 p-6 transition-transform duration-300 ease-in-out flex flex-col ${
                viewNav.currentView === "projects" ? "-translate-x-full invisible" : "translate-x-0"
              }`}
            >
              <ConnectionList
                connections={sshManager.connections}
                onConnectionClick={viewNav.handleConnectionClick}
                onNewConnection={handleNewConnection}
                loading={isLoading}
              />
            </div>

            {/* Projects View */}
            <div
              className={`absolute inset-0 p-6 transition-transform duration-300 ease-in-out flex flex-col ${
                viewNav.currentView === "projects" ? "translate-x-0" : "translate-x-full"
              }`}
            >
              {sshManager.activeConnection && sshManager.activeConnection.type === "local" && (
                <LocalProjectsList
                  recentProjects={sortedRecentProjects}
                  onProjectClick={projectSelection.handleProjectClick}
                  onSelectNewClick={viewNav.handleSelectNewLocal}
                  onBack={viewNav.handleBackToConnections}
                  onRemoveProject={projectSelection.handleRemoveRecentProject}
                  loading={isLoading}
                />
              )}
              {sshManager.activeConnection && sshManager.activeConnection.type === "ssh" && sshManager.activeConnection.sshConnection && (
                <RemoteProjectsList
                  connection={sshManager.activeConnection.sshConnection}
                  recentProjects={sortedRecentProjects}
                  onProjectClick={projectSelection.handleProjectClick}
                  onSelectNewClick={viewNav.handleRemoteSelectProject}
                  onBack={viewNav.handleBackToConnections}
                  onRemoveProject={projectSelection.handleRemoveRecentProject}
                  onConnectionRenamed={sshManager.loadSshConnections}
                  loading={isLoading}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Password Modal */}
      <PasswordModal
        open={sshManager.showPasswordModal}
        connection={sshManager.activeConnection?.sshConnection || null}
        onSubmit={handlePasswordSubmit}
        onCancel={sshManager.handlePasswordCancel}
        loading={sshManager.loading}
      />

      {/* File Picker Modal (Local or Remote) */}
      <Dialog open={viewNav.showFilePickerModal} onOpenChange={viewNav.setShowFilePickerModal}>
        <DialogContent className="max-w-4xl h-150 p-0 flex flex-col">
          <FilePicker
            connection={sshManager.activeConnection?.sshConnection || null}
            onProjectSelect={projectSelection.handleProjectSelect}
            loading={projectSelection.loading}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
