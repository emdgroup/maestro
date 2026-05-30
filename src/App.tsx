import { useEffect, useState, useRef, lazy, Suspense, useCallback, useMemo } from "react";
import { motion, useAnimationControls } from "framer-motion";
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
import { PAGE_TRANSITION_DURATION, PAGE_TRANSITION_EASING } from "@/utils/constants/animations";
import { KanbanProvider } from "@/contexts/KanbanContext";
import { connectionKeyFromProject } from "@/lib/connection-utils";
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

const NOOP = () => {};

function App() {
  const [showMissingDialog, setShowMissingDialog] = useState(false);

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
  const kanbanControls = useAnimationControls();
  const worktreesControls = useAnimationControls();
  const settingsControls = useAnimationControls();
  const prevTabRef = useRef<ViewType>(activeTab);

  const viewControls = useMemo(
    () =>
      ({
        kanban: kanbanControls,
        agents: agentsControls,
        worktrees: worktreesControls,
        settings: settingsControls,
      }) satisfies Record<ViewType, ReturnType<typeof useAnimationControls>>,
    [kanbanControls, agentsControls, worktreesControls, settingsControls],
  );

  // Zombie worktree cleanup on project open (REQ-36)
  const cleanupZombiesMutation = useCleanupZombieWorktreesMutation();

  // D-19 cascade check: verify issue tracking integration is still connected after project opens
  const { data: integrations, isLoading: integrationsLoading } = useListIntegrations();
  const { data: issueTrackingConfig, isLoading: issueTrackingLoading } =
    useProjectIssueTrackingConfig(currentProject?.id ?? 0);

  // Running agent count for header badge
  const { data: sessions = [] } = useActiveSessionsQuery(currentProject?.id);
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
    if (prevTab === activeTab) return;

    const exitingTab = prevTab;
    viewControls[exitingTab]
      .start({
        x: `${-100 * slideDirection}%`,
        opacity: 0,
        transition: { duration: PAGE_TRANSITION_DURATION, ease: PAGE_TRANSITION_EASING },
      })
      .then(() => {
        // Reset x to 0 so stale percentage pixels don't affect layout on window resize.
        // Guard: only reset if this tab is still inactive.
        if (prevTabRef.current !== exitingTab) {
          viewControls[exitingTab].set({ x: 0, opacity: 0 });
        }
      });

    viewControls[activeTab].set({ x: `${100 * slideDirection}%`, opacity: 0 });
    viewControls[activeTab].start({
      x: 0,
      opacity: 1,
      transition: { duration: PAGE_TRANSITION_DURATION, ease: PAGE_TRANSITION_EASING },
    });
  }, [activeTab, slideDirection, viewControls]);

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
    setShowMissingDialog(!integration || !integration.connected);
  }, [
    currentProject,
    integrations,
    issueTrackingConfig,
    integrationsLoading,
    issueTrackingLoading,
  ]);

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
        {/* Agents View — always mounted, imperative animation */}
        <motion.div
          initial={{ opacity: activeTab === "agents" ? 1 : 0 }}
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
              connection={connectionKeyFromProject(currentProject)}
            />
          </Suspense>
        </motion.div>
        {/* Kanban View — always mounted, imperative animation */}
        <motion.div
          initial={{ opacity: activeTab === "kanban" ? 1 : 0 }}
          animate={kanbanControls}
          className={cn(
            "absolute inset-0 overflow-hidden",
            activeTab !== "kanban" && "pointer-events-none",
          )}
        >
          <Suspense fallback={fallback}>
            <KanbanProvider
              projectId={currentProject.id}
              projectPath={currentProject.path}
              connection={connectionKeyFromProject(currentProject)}
              onTaskClick={NOOP}
            >
              <KanbanView />
            </KanbanProvider>
          </Suspense>
        </motion.div>

        {/* Worktrees View — always mounted, imperative animation */}
        <motion.div
          initial={{ opacity: activeTab === "worktrees" ? 1 : 0 }}
          animate={worktreesControls}
          className={cn(
            "absolute inset-0 overflow-hidden",
            activeTab !== "worktrees" && "pointer-events-none",
          )}
        >
          <Suspense fallback={fallback}>
            <WorktreesView projectId={currentProject.id} repoPath={currentProject.path} />
          </Suspense>
        </motion.div>

        {/* Settings View — always mounted, imperative animation */}
        <motion.div
          initial={{ opacity: activeTab === "settings" ? 1 : 0 }}
          animate={settingsControls}
          className={cn(
            "absolute inset-0 overflow-hidden",
            activeTab !== "settings" && "pointer-events-none",
          )}
        >
          <div className="h-full overflow-auto custom-scrollbar">
            <Suspense fallback={fallback}>
              <SettingsView
                ref={settingsPageRef}
                projectId={currentProject.id}
                connection={connectionKeyFromProject(currentProject)}
              />
            </Suspense>
          </div>
        </motion.div>
      </main>

      {/* D-19 cascade check: block project access when issue tracking integration is missing */}
      <IntegrationMissingDialog
        open={showMissingDialog}
        projectId={currentProject.id}
        provider={issueTrackingConfig?.provider ?? ""}
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
