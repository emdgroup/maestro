import { useEffect, useState, useRef, lazy, Suspense, useCallback, useMemo } from "react";
import { ShortcutHintProvider } from "@/components/common/shortcut-hint/ShortcutHintProvider";
import { useShortcuts } from "@/utils/hooks/useShortcuts";
import { motion, useAnimationControls } from "framer-motion";
import { useSelectedProject, useSelectedProjectActions } from "@/store/projectStore";
import { AppHeader } from "@/components/layout/app-header/AppHeader";
import type { SettingsPageHandle } from "@/views/settings/settings-page/SettingsPage";
import { ProjectPickerView } from "@/views/project-picker/ProjectPickerView";
import { useSettings } from "@/services/settings.service";
import {
  useCleanupZombieWorktreesMutation,
  usePrefetchWorktrees,
} from "@/services/worktree.service";
import { useActiveSessionsQuery } from "@/services/execution.service";
import { useSessionActivityStore } from "@/store/sessionActivityStore";
import { useConnectionHealth } from "@/utils/hooks/useConnectionHealth";
import { DisconnectBackdrop } from "@/components/common/disconnect-backdrop/DisconnectBackdrop";
import {
  useActiveTab,
  useSlideDirection,
  useNavigationActions,
  type ViewType,
} from "@/store/navigationStore";
import { useProjectSettings } from "@/services/project.service";
import { PAGE_TRANSITION_DURATION, PAGE_TRANSITION_EASING } from "@/utils/constants/animations";
import { KanbanProvider } from "@/contexts/KanbanContext";
import { connectionKeyFromProject } from "@/lib/connection-utils";
import { TooltipProvider } from "@/ui/tooltip";
import { cn } from "@/lib/utils.ts";
import { useListIntegrations, useProjectIssueTrackingConfig } from "@/services/integration.service";
import { IntegrationMissingDialog } from "@/views/project-picker/integrations-tab/IntegrationMissingDialog";
import { useUpdater } from "@/hooks/useUpdater";
import { UpdateSplashScreen } from "@/components/execution/UpdateSplashScreen";
import "./App.css";

// Lazy load views for code splitting (performance optimization)
const KanbanView = lazy(() =>
  import("@/views/kanban/KanbanView").then((m) => ({ default: m.KanbanView })),
);
const AgentsView = lazy(() =>
  import("@/views/agents/AgentsView").then((m) => ({ default: m.AgentsView })),
);
const WorktreesView = lazy(() =>
  import("@/views/worktrees/WorktreesView").then((m) => ({ default: m.WorktreesView })),
);
const SettingsView = lazy(() =>
  import("@/views/settings/SettingsView").then((m) => ({ default: m.SettingsView })),
);

const NOOP = () => {};

function App() {
  const [dismissedForProjectId, setDismissedForProjectId] = useState<number | null>(null);

  // Subscribe to project store for project selection
  const currentProject = useSelectedProject();
  const { clearSelectedProject, setSelectedProject } = useSelectedProjectActions();
  const settingsPageRef = useRef<SettingsPageHandle>(null);
  const startupTabAppliedForRef = useRef<number | null>(null);

  // Query hooks for settings
  const { isLoading: settingsLoading, error: settingsError, data: appSettings } = useSettings();

  // Updater — startup check fires once when settings are ready
  const { status: updateStatus, checkForUpdates } = useUpdater();
  const autoUpdate = appSettings?.auto_update ?? false;

  useEffect(() => {
    if (!settingsLoading && !settingsError) {
      checkForUpdates(autoUpdate);
    }
    // Run once on mount after settings resolve
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoading]);

  // Page routing backed by navigationStore
  const activeTab = useActiveTab();
  const slideDirection = useSlideDirection();
  const { setActiveTab } = useNavigationActions();

  useShortcuts("global", {
    "tab-board": () => setActiveTab("kanban"),
    "tab-agents": () => setActiveTab("agents"),
    "tab-worktrees": () => setActiveTab("worktrees"),
    "tab-settings": () => setActiveTab("settings"),
    "prevent-reload": () => {},
    "prevent-reload-shift": () => {},
    "prevent-reload-f5": () => {},
  });

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
  const { mutate: cleanupZombies } = useCleanupZombieWorktreesMutation();
  const prefetchWorktrees = usePrefetchWorktrees();

  // D-19 cascade check: verify issue tracking integration is still connected after project opens
  const { data: integrations, isLoading: integrationsLoading } = useListIntegrations();
  const { data: issueTrackingConfig, isLoading: issueTrackingLoading } =
    useProjectIssueTrackingConfig(currentProject?.id ?? 0);

  // Derived: true only when the user dismissed the dialog for the current project specifically.
  const integrationDismissed = dismissedForProjectId === currentProject?.id;

  // Derived: show the dialog when project is loaded, queries settled, config present, and not connected.
  const showMissingDialog =
    !integrationDismissed &&
    !!currentProject &&
    !integrationsLoading &&
    !issueTrackingLoading &&
    !!issueTrackingConfig &&
    !integrations?.find((i) => i.provider === issueTrackingConfig.provider && i.connected);

  // Stable connection key — memoized so downstream hooks don't churn on every render.
  const connection = useMemo(
    () => (currentProject ? connectionKeyFromProject(currentProject) : { type: "local" as const }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentProject?.id, currentProject?.connection_id, currentProject?.wsl_connection_id],
  );

  // Running agent count for header badge
  const { data: sessions = [] } = useActiveSessionsQuery(currentProject?.id);
  const activitySessions = useSessionActivityStore((s) => s.sessions);
  const runningAgentCount = sessions.filter((s) => {
    const activity = activitySessions[s.session_key];
    return activity && activity.status !== "idle" && activity.status !== "awaiting_input";
  }).length;

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
      prefetchWorktrees(currentProject.id, currentProject.path);
      cleanupZombies({
        projectId: currentProject.id,
        repoPath: currentProject.path,
      });
    }
  }, [currentProject, cleanupZombies, prefetchWorktrees]);

  // Startup preferences — applied once per project open.
  const { data: projectSettings } = useProjectSettings(currentProject?.id ?? 0);

  useEffect(() => {
    if (!currentProject || !projectSettings?.startup_tab) return;
    if (startupTabAppliedForRef.current === currentProject.id) return;
    startupTabAppliedForRef.current = currentProject.id;
    const validTabs = new Set<ViewType>(["kanban", "agents", "worktrees", "settings"]);
    const tab = projectSettings.startup_tab as ViewType;
    if (validTabs.has(tab)) {
      setActiveTab(tab);
    }
  }, [currentProject, projectSettings?.startup_tab, setActiveTab]);

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

  if (autoUpdate && updateStatus.phase === "downloading") {
    return <UpdateSplashScreen status={updateStatus} />;
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
    <TooltipProvider>
      <ShortcutHintProvider>
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
                  connection={connection}
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
                  connection={connection}
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
                    connection={connection}
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
            onDropConfig={() => setDismissedForProjectId(currentProject?.id ?? null)}
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
      </ShortcutHintProvider>
    </TooltipProvider>
  );
}

export default App;
