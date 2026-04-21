import { useEffect, useState, useRef, lazy, Suspense, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useSelectedProject, useSelectedProjectActions } from "@/store/projectStore";
import { AppHeader } from "@/components/common/AppHeader";
import type { SettingsPageHandle } from "@/components/common/SettingsPage";
import { useBoardStore } from "@/store/boardStore";
import type { Task } from "@/types/bindings";
import { ProjectPickerView } from "@/views/ProjectPickerView";
import { useSettings } from "@/services/settings.service";
import { useCleanupZombieWorktreesMutation } from "@/services/worktree.service";
import { useExecutionsWithTaskInfoQuery } from "@/services/execution.service";
import { useConnectionHealth } from "@/utils/hooks/useConnectionHealth";
import { DisconnectBackdrop } from "@/components/common/DisconnectBackdrop";
import {
  useActiveTab,
  useSlideDirection,
  usePendingTaskId,
  useNavigationActions,
} from "@/store/navigationStore";
import {
  slideVariants,
  PAGE_TRANSITION_DURATION,
  PAGE_TRANSITION_EASING,
} from "@/utils/constants/animations";
import { KanbanProvider } from "@/contexts/KanbanContext";
import { toast } from "sonner";
import "./App.css";

// Lazy load views for code splitting (performance optimization)
const KanbanView = lazy(() =>
  import("@/views/KanbanView").then((m) => ({ default: m.KanbanView })),
);
const AgentsView = lazy(() =>
  import("@/views/AgentsView").then((m) => ({ default: m.AgentsView })),
);
const WorktreesView = lazy(() =>
  import("@/views/WorktreesView").then((m) => ({ default: m.WorktreesView })),
);
const SettingsView = lazy(() =>
  import("@/views/SettingsView").then((m) => ({ default: m.SettingsView })),
);

// Lazy load modals for code splitting (performance optimization)
const TaskModal = lazy(() =>
  import("@/components/kanban/TaskModal").then((m) => ({ default: m.TaskModal })),
);
const TaskDetail = lazy(() =>
  import("@/components/task/TaskDetail").then((m) => ({ default: m.TaskDetail })),
);
const ImportSettings = lazy(() =>
  import("@/components/task/ImportSettings").then((m) => ({ default: m.ImportSettings })),
);

function App() {
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [showImportSettings, setShowImportSettings] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  // Subscribe to project store for project selection
  const currentProject = useSelectedProject();
  const { clearSelectedProject, setSelectedProject } = useSelectedProjectActions();
  const { addTask } = useBoardStore();
  const settingsPageRef = useRef<SettingsPageHandle>(null);

  // Query hooks for settings
  const { isLoading: settingsLoading, error: settingsError } = useSettings();

  // Page routing backed by navigationStore
  const activeTab = useActiveTab();
  const slideDirection = useSlideDirection();
  const { setActiveTab, clearPendingTask } = useNavigationActions();

  // Zombie worktree cleanup on project open (REQ-36)
  const cleanupZombiesMutation = useCleanupZombieWorktreesMutation();

  // Running agent count for header badge
  const { data: executions = [] } = useExecutionsWithTaskInfoQuery(currentProject?.id);
  const runningAgentCount = executions.filter((e) => e.status === "running").length;

  // SSH connection health monitoring — only active for SSH projects
  const {
    state: connectionHealth,
    attempt: reconnectAttempt,
    maxAttempts: reconnectMaxAttempts,
    dismiss: dismissBackdrop,
  } = useConnectionHealth(currentProject?.connection_id ?? null);

  // Leave Connection: reset health state then navigate back to project picker
  const handleLeaveConnection = useCallback(() => {
    dismissBackdrop();
    clearSelectedProject();
  }, [dismissBackdrop, clearSelectedProject]);

  // Consume pendingTaskId from store to open TaskDetail sheet
  const pendingTaskId = usePendingTaskId();
  const tasks = useBoardStore((s) => s.tasks);

  useEffect(() => {
    if (pendingTaskId) {
      const task = tasks.find((t) => String(t.id) === pendingTaskId) ?? null;
      setSelectedTask(task);
      clearPendingTask();
    }
  }, [pendingTaskId, tasks, clearPendingTask]);

  useEffect(() => {
    if (currentProject) {
      cleanupZombiesMutation.mutate({
        projectId: currentProject.id,
        repoPath: currentProject.path,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id]);

  // Log settings errors (if any)
  useEffect(() => {
    if (settingsError) {
      console.error("[DEBUG] App.tsx: Failed to load settings:", settingsError);
      toast.error("Failed to load settings");
    }
  }, [settingsError]);

  function handleTaskCreated(newTask: Task) {
    addTask(newTask);
  }

  function handleImportConfigSaved() {
    // Settings saved, can now enable sync button
    setShowImportSettings(false);
  }

  const fallback = (
    <div className="flex items-center justify-center h-full">
      <p className="text-sm text-muted-foreground">Loading...</p>
    </div>
  );

  return (
    <>
      {settingsLoading ? (
        <div className="app">
          <p>Loading...</p>
        </div>
      ) : settingsError ? (
        <div className="app">
          <p>Error loading settings: {settingsError.message}</p>
        </div>
      ) : !currentProject ? (
        <ProjectPickerView />
      ) : (
        <div className="app flex flex-col h-screen bg-background">
          <AppHeader
            currentProject={currentProject}
            activeView={activeTab}
            onViewChange={setActiveTab}
            onProjectChange={setSelectedProject}
            onBackToPicker={clearSelectedProject}
            agentCount={runningAgentCount}
          />
          <main className="flex-1 overflow-hidden relative">
            <AnimatePresence initial={false} custom={slideDirection}>
              {activeTab === "kanban" && (
                <motion.div
                  key="kanban"
                  custom={slideDirection}
                  variants={slideVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{
                    duration: PAGE_TRANSITION_DURATION,
                    ease: PAGE_TRANSITION_EASING,
                  }}
                  className="absolute inset-0 overflow-auto custom-scrollbar"
                >
                  <Suspense fallback={fallback}>
                    <KanbanProvider
                      projectId={currentProject.id}
                      projectPath={currentProject.path}
                      onTaskClick={setSelectedTask}
                      onAddTask={() => setShowNewTaskModal(true)}
                    >
                      <KanbanView />
                    </KanbanProvider>
                  </Suspense>
                </motion.div>
              )}

              {activeTab === "agents" && (
                <motion.div
                  key="agents"
                  custom={slideDirection}
                  variants={slideVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{
                    duration: PAGE_TRANSITION_DURATION,
                    ease: PAGE_TRANSITION_EASING,
                  }}
                  className="absolute inset-0 overflow-auto custom-scrollbar"
                >
                  <Suspense fallback={fallback}>
                    <AgentsView projectId={currentProject.id} repoPath={currentProject.path} connectionId={currentProject.connection_id} />
                  </Suspense>
                </motion.div>
              )}

              {activeTab === "worktrees" && (
                <motion.div
                  key="worktrees"
                  custom={slideDirection}
                  variants={slideVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{
                    duration: PAGE_TRANSITION_DURATION,
                    ease: PAGE_TRANSITION_EASING,
                  }}
                  className="absolute inset-0 overflow-auto custom-scrollbar"
                >
                  <Suspense fallback={fallback}>
                    <WorktreesView projectId={currentProject.id} repoPath={currentProject.path} />
                  </Suspense>
                </motion.div>
              )}

              {activeTab === "settings" && (
                <motion.div
                  key="settings"
                  custom={slideDirection}
                  variants={slideVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{
                    duration: PAGE_TRANSITION_DURATION,
                    ease: PAGE_TRANSITION_EASING,
                  }}
                  className="absolute inset-0 overflow-auto custom-scrollbar"
                >
                  <Suspense fallback={fallback}>
                    <SettingsView ref={settingsPageRef} projectId={currentProject.id} />
                  </Suspense>
                </motion.div>
              )}
            </AnimatePresence>

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

          {/* SSH connection loss overlay — blocks interaction during reconnect */}
          {connectionHealth !== "connected" && (
            <DisconnectBackdrop
              state={connectionHealth}
              attempt={reconnectAttempt}
              maxAttempts={reconnectMaxAttempts}
              onLeaveConnection={handleLeaveConnection}
            />
          )}
        </div>
      )}
    </>
  );
}

export default App;
