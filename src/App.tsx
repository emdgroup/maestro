import { useEffect, useState, useRef, lazy, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useSelectedProject } from "@/store/projectStore";
import { AppHeader, ActionBar } from "@/components/common";
import type { SettingsPageHandle } from "@/components/common";
import { useBoardStore } from "@/store/boardStore";
import type { Project, Task } from "@/types/bindings";
import { ProjectPickerView } from "@/views";
import { useSettings } from "@/services/settings.service";
import {
  usePageRouting,
  getPageActions,
  slideVariants,
  PAGE_TRANSITION_DURATION,
  PAGE_TRANSITION_EASING
} from "@/utils";
import { toast } from "sonner";
import "./App.css";

// Lazy load views for code splitting (performance optimization)
const KanbanView = lazy(() => import("@/views").then(m => ({ default: m.KanbanView })));
const AgentsView = lazy(() => import("@/views").then(m => ({ default: m.AgentsView })));
const WorktreesView = lazy(() => import("@/views").then(m => ({ default: m.WorktreesView })));
const SettingsView = lazy(() => import("@/views").then(m => ({ default: m.SettingsView })));

// Lazy load modals for code splitting (performance optimization)
const TaskModal = lazy(() => import("@/components/kanban").then(m => ({ default: m.TaskModal })));
const TaskDetail = lazy(() => import("@/components/task").then(m => ({ default: m.TaskDetail })));
const ImportSettings = lazy(() => import("@/components/task").then(m => ({ default: m.ImportSettings })));

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
  const { addTask } = useBoardStore();
  const settingsPageRef = useRef<SettingsPageHandle>(null);

  // Query hooks for settings
  const { data: settings, isLoading: settingsLoading, error: settingsError } = useSettings();

  // Page routing with slide animations
  const { activePage, slideDirection, handlePageChange } = usePageRouting("kanban");

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

  function handleProjectSelected(project: Project) {
    console.log(`[DEBUG] App.tsx: Project selected - ${project.name} (${project.path})`);
    setCurrentProject(project);
  }

  function handleTaskCreated(newTask: Task) {
    addTask(newTask);
  }

  function handleImportConfigSaved() {
    // Settings saved, can now enable sync button
    setShowImportSettings(false);
  }

  // Get page-specific actions using utility function
  const pageActions = getPageActions(activePage, {
    onAddTask: () => setShowNewTaskModal(true),
    onResetSettings: () => settingsPageRef.current?.resetToDefaults(),
    onSaveSettings: async () => await settingsPageRef.current?.save(),
  });

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
            onProjectChange={handleProjectSelected}
            onBackToPicker={() => setCurrentProject(null)}
            agentCount={0}
          />
          <ActionBar actions={pageActions} />
          <main className="flex-1 overflow-hidden relative">
            <Suspense fallback={<div className="flex items-center justify-center h-full"><p className="text-sm text-muted-foreground">Loading...</p></div>}>
              <AnimatePresence initial={false} custom={slideDirection}>
                {activePage === "kanban" && (
                  <motion.div
                    key="kanban"
                    custom={slideDirection}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: PAGE_TRANSITION_DURATION, ease: PAGE_TRANSITION_EASING }}
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
                    transition={{ duration: PAGE_TRANSITION_DURATION, ease: PAGE_TRANSITION_EASING }}
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
                    transition={{ duration: PAGE_TRANSITION_DURATION, ease: PAGE_TRANSITION_EASING }}
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
                    transition={{ duration: PAGE_TRANSITION_DURATION, ease: PAGE_TRANSITION_EASING }}
                    className="absolute inset-0 overflow-auto custom-scrollbar"
                  >
                    <SettingsView ref={settingsPageRef} projectId={currentProject.id} />
                  </motion.div>
                )}
              </AnimatePresence>
            </Suspense>

            {/* Modals and Overlays - lazy loaded for performance */}
            <Suspense fallback={null}>
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
            </Suspense>
          </main>
        </div>
      )}
    </>
  );
}

export default App;
