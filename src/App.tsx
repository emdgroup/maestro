import { useEffect, useState, useRef, lazy, Suspense, useCallback } from "react";
import { motion, AnimatePresence, useAnimationControls } from "framer-motion";
import { useSelectedProject, useSelectedProjectActions } from "@/store/projectStore";
import { AppHeader } from "@/components/common/AppHeader";
import type { SettingsPageHandle } from "@/components/common/SettingsPage";
import { ProjectPickerView } from "@/views/ProjectPickerView";
import { useSettings } from "@/services/settings.service";
import { useCleanupZombieWorktreesMutation } from "@/services/worktree.service";
import { useActiveSessionsQuery } from "@/services/execution.service";
import { useConnectionHealth } from "@/utils/hooks/useConnectionHealth";
import { DisconnectBackdrop } from "@/components/common/DisconnectBackdrop";
import {
  useActiveTab,
  useSlideDirection,
  useNavigationActions,
  type ViewType,
} from "@/store/navigationStore";
import {
  slideVariants,
  PAGE_TRANSITION_DURATION,
  PAGE_TRANSITION_EASING,
} from "@/utils/constants/animations";
import { KanbanProvider } from "@/contexts/KanbanContext";
import { cn } from "@/lib/ui-utils";
import { useListIntegrations, useProjectIssueTrackingConfig } from "@/services/integration.service";
import { IntegrationMissingDialog } from "@/components/project-picker/IntegrationMissingDialog";
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

function App() {
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [showMissingDialog, setShowMissingDialog] = useState(false);
  const [missingProvider, setMissingProvider] = useState<string | null>(null);

  // Subscribe to project store for project selection
  const currentProject = useSelectedProject();
  const { clearSelectedProject, setSelectedProject } = useSelectedProjectActions();
  const settingsPageRef = useRef<SettingsPageHandle>(null);

  // Query hooks for settings
  const { isLoading: settingsLoading, error: settingsError } = useSettings();

  // Page routing backed by navigationStore
  const activeTab = useActiveTab();
  const slideDirection = useSlideDirection();
  const { setActiveTab } = useNavigationActions();

  const agentsControls = useAnimationControls();
  const prevTabRef = useRef<ViewType>(activeTab);

  // Zombie worktree cleanup on project open (REQ-36)
  const cleanupZombiesMutation = useCleanupZombieWorktreesMutation();

  // D-19 cascade check: verify issue tracking integration is still connected after project opens
  const { data: integrations, isLoading: integrationsLoading } = useListIntegrations();
  const { data: issueTrackingConfig, isLoading: issueTrackingLoading } = useProjectIssueTrackingConfig(
    currentProject?.id ?? 0,
  );

  // Running agent count for header badge
  const { data: sessions = [] } = useActiveSessionsQuery();
  const runningAgentCount = sessions.length;

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

  useEffect(() => {
    const prevTab = prevTabRef.current;
    prevTabRef.current = activeTab;

    if (activeTab === "agents" && prevTab !== "agents") {
      agentsControls.set({ x: `${100 * slideDirection}%`, opacity: 0 });
      agentsControls.start({
        x: 0,
        opacity: 1,
        transition: { duration: PAGE_TRANSITION_DURATION, ease: PAGE_TRANSITION_EASING },
      });
    } else if (activeTab !== "agents" && prevTab === "agents") {
      agentsControls.start({
        x: `${-100 * slideDirection}%`,
        opacity: 0,
        transition: { duration: PAGE_TRANSITION_DURATION, ease: PAGE_TRANSITION_EASING },
      });
    }
  }, [activeTab, slideDirection, agentsControls]);

  useEffect(() => {
    if (currentProject) {
      cleanupZombiesMutation.mutate({
        projectId: currentProject.id,
        repoPath: currentProject.path,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id]);

  useEffect(() => {
    if (!currentProject || integrationsLoading || issueTrackingLoading) return;
    if (!issueTrackingConfig) {
      setShowMissingDialog(false);
      return;
    }
    const integration = integrations?.find((i) => i.provider === issueTrackingConfig.provider);
    if (!integration || !integration.connected) {
      setMissingProvider(issueTrackingConfig.provider);
      setShowMissingDialog(true);
    } else {
      setShowMissingDialog(false);
    }
  }, [currentProject, integrations, issueTrackingConfig, integrationsLoading, issueTrackingLoading]);

  if (settingsLoading) {
    return (
      <div className="app">
        <p>Loading...</p>
      </div>
    );
  }

  if (settingsError) {
    return (
      <div className="app">
        <p>Error loading settings: {settingsError.message}</p>
      </div>
    );
  }

  if (!currentProject) {
    return <ProjectPickerView />;
  }

  const fallback = (
    <div className="flex items-center justify-center h-full">
      <p className="text-sm text-muted-foreground">Loading...</p>
    </div>
  );

  return (
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
        {/* AgentsView always mounted — session state survives tab navigation */}
        <motion.div
          initial={activeTab === "agents" ? { x: 0, opacity: 1 } : { x: "100%", opacity: 0 }}
          animate={agentsControls}
          className={cn(
            "absolute inset-0 overflow-hidden",
            activeTab !== "agents" && "pointer-events-none",
          )}
        >
          <Suspense fallback={fallback}>
            <AgentsView
              projectId={currentProject.id}
              repoPath={currentProject.path}
              connectionId={currentProject.connection_id}
              wslConnectionId={currentProject.wsl_connection_id}
            />
          </Suspense>
        </motion.div>
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
                  onTaskClick={() => {}}
                  onAddTask={() => setShowNewTaskModal(true)}
                >
                  <KanbanView />
                </KanbanProvider>
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
                <SettingsView
                  ref={settingsPageRef}
                  projectId={currentProject.id}
                  connectionId={currentProject.connection_id}
                  wslConnectionId={currentProject.wsl_connection_id}
                />
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
          />
        </Suspense>
      </main>

      {/* D-19 cascade check: block project access when issue tracking integration is missing */}
      <IntegrationMissingDialog
        open={showMissingDialog}
        projectId={currentProject.id}
        provider={missingProvider ?? ""}
        onFixIntegration={clearSelectedProject}
        onDropConfig={() => setShowMissingDialog(false)}
      />

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
  );
}

export default App;
