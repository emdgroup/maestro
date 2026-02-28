import { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useSelectedProject } from "@/store/projectStore";
import { AppHeader, ActionBar } from "@/components/common";
import { TaskModal } from "@/components/kanban";
import { TaskDetail, ImportSettings } from "@/components/task";
import type { SettingsPageHandle } from "@/components/common";
import { useBoardStore } from "@/store/boardStore";
import { useRecentProjects } from "@/utils/hooks";
import type { ActionBarAction } from "@/components/common";
import { Plus, Save, RotateCcw } from "lucide-react";
import type { AppSettings, Project, Task } from "@/types/bindings";
import { KanbanView, ProjectPickerView, WorktreesView, AgentsView, SettingsView } from "@/views";
import { useSettingsQuery, useSaveSettingsMutation } from "@/services/settings.service";
import { toast } from "sonner";
import "./App.css";

function App() {
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [appLoading, setAppLoading] = useState(true);

  // Subscribe to project store for project selection
  const selectedProject = useSelectedProject();

  // Check if Tauri is available on mount (Tauri 2 uses __TAURI__)
  console.log(
    "[DEBUG] App.tsx: Tauri available?",
    typeof (window as any).__TAURI__ !== "undefined",
  );
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [showImportSettings, setShowImportSettings] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [activePage, setActivePage] = useState<"kanban" | "agents" | "worktrees" | "settings">(
    "kanban",
  );
  const [slideDirection, setSlideDirection] = useState(1);
  const { addTask } = useBoardStore();
  const settingsPageRef = useRef<SettingsPageHandle>(null);

  // Query hooks for settings and mutations
  const { data: settings, isLoading: settingsLoading, error: settingsError } = useSettingsQuery();
  const { mutate: saveSettings } = useSaveSettingsMutation();

  // Load recent projects for filtering dropdown (AppHeader will do the filtering)
  const { data: recentProjects = [] } = useRecentProjects(currentProject?.connection_id);

  // Page order for determining slide direction
  const pageOrder = { kanban: 0, agents: 1, worktrees: 2, settings: 3 };

  // Define slide variants for consistent animation
  const slideVariants = {
    enter: (direction: number) => ({
      x: `${100 * direction}%`,
      opacity: 0,
    }),
    center: {
      x: 0,
      opacity: 1,
    },
    exit: (direction: number) => ({
      x: `${-100 * direction}%`,
      opacity: 0,
    }),
  };

  // Update active page and calculate slide direction
  const handlePageChange = (page: typeof activePage) => {
    if (page === activePage) return; // Don't animate if clicking same tab

    const currentIndex = pageOrder[activePage];
    const newIndex = pageOrder[page];
    // 1 = moving right (new page > current), -1 = moving left (new page < current)
    const direction = newIndex > currentIndex ? 1 : -1;

    setSlideDirection(direction);
    setActivePage(page);
  };

  // Initialize app when settings are loaded
  useEffect(() => {
    async function initialize() {
      if (settingsError) {
        console.error("[DEBUG] App.tsx: Failed to load settings:", settingsError);
        toast.error("Failed to load settings");
        setAppLoading(false);
        return;
      }

      if (!settings) {
        // Still loading
        return;
      }

      setAppLoading(false);
    }

    void initialize();
  }, [settings, settingsError]);

  // Handle project selection from project store
  useEffect(() => {
    setCurrentProject(selectedProject);
  }, [selectedProject]);

  async function handleProjectSelected(project: Project) {
    try {
      console.log(`[DEBUG] App.tsx: handleProjectSelected starting with path: ${project.path}`);
      console.log("[DEBUG] App.tsx: Project created/loaded successfully", project);
      setCurrentProject(project);

      const newSettings: AppSettings = {
        theme_preference: settings?.theme_preference || "system",
        updated_at: new Date().toISOString(),
      };

      console.log("[DEBUG] App.tsx: Saving settings with new project path");
      saveSettings(newSettings);

      console.log("[DEBUG] App.tsx: Project selected, main UI should now be visible");
    } catch (err) {
      console.error("[DEBUG] App.tsx: Failed in handleProjectSelected:", err);
      // Show error to user
      toast.error(`Failed to load project: ${err}`);
    }
  }

  function handleTaskCreated(newTask: Task) {
    addTask(newTask);
  }

  function handleImportConfigSaved() {
    // Settings saved, can now enable sync button
    setShowImportSettings(false);
  }

  // Define page-specific actions
  function getPageActions(): ActionBarAction[] {
    switch (activePage) {
      case "kanban":
        return [
          {
            id: "add-task",
            label: "Add Task",
            icon: Plus,
            variant: "accent",
            onClick: () => setShowNewTaskModal(true),
            align: "right",
          },
        ];
      case "agents":
        return [];
      case "worktrees":
        return [];
      case "settings":
        return [
          {
            id: "reset",
            label: "Reset to Defaults",
            icon: RotateCcw,
            variant: "ghost",
            onClick: () => {
              settingsPageRef.current?.resetToDefaults();
            },
          },
          {
            id: "save",
            label: "Save",
            icon: Save,
            variant: "accent",
            onClick: async () => {
              await settingsPageRef.current?.save();
            },
            align: "right",
          },
        ];
      default:
        return [];
    }
  }

  // Log current state before render
  console.log(
    "[DEBUG] App.tsx render: appLoading=",
    appLoading,
    "settingsLoading=",
    settingsLoading,
    "currentProject=",
    currentProject?.path || "null",
  );

  return (
    <>
      {appLoading || settingsLoading ? (
        <div className="app">
          <p>Loading...</p>
        </div>
      ) : !currentProject ? (
        <ProjectPickerView />
      ) : (
        <div className="app flex flex-col h-screen bg-background">
          <AppHeader
            currentProject={currentProject}
            activeView={activePage}
            onViewChange={handlePageChange}
            recentProjects={recentProjects}
            onProjectChange={handleProjectSelected}
            onBackToPicker={() => setCurrentProject(null)}
            agentCount={0}
          />
          <ActionBar actions={getPageActions()} />
          <main className="flex-1 overflow-hidden relative">
            <AnimatePresence initial={false} custom={slideDirection}>
              {activePage === "kanban" && (
                <motion.div
                  key="kanban"
                  custom={slideDirection}
                  variants={slideVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.25, ease: "easeInOut" }}
                  className="absolute inset-0 overflow-auto custom-scrollbar"
                >
                  <KanbanView
                    projectId={currentProject.id}
                    projectPath={currentProject.path}
                    onTaskClick={setSelectedTask}
                  />
                </motion.div>
              )}

              {activePage === "agents" && (
                <motion.div
                  key="agents"
                  custom={slideDirection}
                  variants={slideVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.25, ease: "easeInOut" }}
                  className="absolute inset-0 overflow-auto custom-scrollbar"
                >
                  <AgentsView projectId={currentProject.id} agents={[]} activeAgentId={null} />
                </motion.div>
              )}

              {activePage === "worktrees" && (
                <motion.div
                  key="worktrees"
                  custom={slideDirection}
                  variants={slideVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.25, ease: "easeInOut" }}
                  className="absolute inset-0 overflow-auto custom-scrollbar"
                >
                  <WorktreesView projectId={currentProject.id} worktrees={[]} />
                </motion.div>
              )}

              {activePage === "settings" && (
                <motion.div
                  key="settings"
                  custom={slideDirection}
                  variants={slideVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.25, ease: "easeInOut" }}
                  className="absolute inset-0 overflow-auto custom-scrollbar"
                >
                  <SettingsView ref={settingsPageRef} projectId={currentProject.id} />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Modals and Overlays */}
            <TaskModal
              isOpen={showNewTaskModal}
              onClose={() => setShowNewTaskModal(false)}
              projectId={currentProject.id}
              onTaskCreated={handleTaskCreated}
            />
            <TaskDetail
              task={selectedTask}
              projectPath={currentProject.path}
              onClose={() => setSelectedTask(null)}
            />
            <ImportSettings
              isOpen={showImportSettings}
              onClose={() => setShowImportSettings(false)}
              onConfigSaved={handleImportConfigSaved}
            />
          </main>
        </div>
      )}
    </>
  );
}

export default App;
