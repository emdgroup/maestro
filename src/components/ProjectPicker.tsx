import { useState } from "react";
import { ConnectionList } from "./ConnectionList";
import { LocalProjectsList } from "./LocalProjectsList";
import { RemoteProjectsList } from "./RemoteProjectsList";
import { PasswordModal } from "./PasswordModal";
import { FilePicker } from "./FilePicker";
import { Dialog, DialogContent } from "./ui/dialog";
import { ThemeToggle } from "./ThemeToggle";
import { useProjectSelection } from "@/hooks/useProjectSelection.ts";
import { useProjectPickerManager } from "@/hooks/useProjectPickerManager.tsx";
import { Project } from "../../src-tauri/bindings/Project.ts";

interface ProjectPickerProps {
  onProjectSelected: (project: Project) => void;
  onRecentProjectsChanged: () => void;
}

export function ProjectPicker({ onProjectSelected, onRecentProjectsChanged }: ProjectPickerProps) {
  const [showFilePickerModal, setShowFilePickerModal] = useState(false);
  const {
    currentView,
    activeConnection,
    connections,
    showPasswordModal,
    loading,
    handleConnection,
    handleNewConnection,
    handleBackToConnections,
    handleRemoteSelectProject,
    handlePasswordSubmit,
    handleSelectNewLocal,
    loadSshConnections,
    handlePasswordCancel,
  } = useProjectPickerManager({ setShowFilePickerModal });

  const {
    loading: projectLoading,
    handleProjectClick,
    handleProjectSelect,
    handleRemoveProject,
  } = useProjectSelection({
    activeConnection,
    onProjectSelected,
    onRecentProjectsChanged,
  });

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
            <h1 className="text-3xl font-semibold mb-3">Agent Orchestrator</h1>
            <p className="text-base text-muted-foreground">Select a connection to get started</p>
          </div>

          {/* Single Panel with Slide Transition */}
          <div className="bg-card border border-border rounded-lg overflow-clip relative min-h-125 max-h-175">
            {/* Connections View */}
            <div
              className={`absolute inset-0 p-6 transition-transform duration-300 ease-in-out flex flex-col ${
                currentView === "projects" ? "-translate-x-full invisible" : "translate-x-0"
              }`}
            >
              <ConnectionList
                connections={connections}
                onConnectionClick={handleConnection}
                onNewConnection={handleNewConnection}
                loading={loading}
              />
            </div>

            {/* Projects View */}
            <div
              className={`absolute inset-0 p-6 transition-transform duration-300 ease-in-out flex flex-col ${
                currentView === "projects" ? "translate-x-0" : "translate-x-full"
              }`}
            >
              {activeConnection && activeConnection.type === "local" && (
                <LocalProjectsList
                  onProjectClick={handleProjectClick}
                  onSelectNewClick={handleSelectNewLocal}
                  onBack={handleBackToConnections}
                  onRemoveProject={handleRemoveProject}
                />
              )}
              {activeConnection &&
                activeConnection.type === "ssh" &&
                activeConnection.sshConnection && (
                  <RemoteProjectsList
                    connection={activeConnection.sshConnection}
                    onProjectClick={handleProjectClick}
                    onSelectNewClick={handleRemoteSelectProject}
                    onBack={handleBackToConnections}
                    onRemoveProject={handleRemoveProject}
                    onConnectionRenamed={loadSshConnections}
                  />
                )}
            </div>
          </div>
        </div>
      </div>

      {/* Password Modal */}
      <PasswordModal
        open={showPasswordModal}
        connection={activeConnection?.sshConnection || null}
        onSubmit={handlePasswordSubmit}
        onCancel={handlePasswordCancel}
        loading={loading}
      />

      {/* File Picker Modal (Local or Remote) */}
      <Dialog open={showFilePickerModal} onOpenChange={setShowFilePickerModal}>
        <DialogContent className="h-150 md:max-w-4xl p-0 flex flex-col [&>button:hover]:text-accent">
          <FilePicker
            connection={activeConnection?.sshConnection || null}
            onProjectSelect={handleProjectSelect}
            loading={projectLoading}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
