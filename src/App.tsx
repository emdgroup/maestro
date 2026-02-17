import { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { safeInvoke } from "./lib/tauri-safe";
import { ProjectPicker } from "./components/ProjectPicker.tsx";
import { KanbanBoard } from "./components/KanbanBoard";
import { AppHeader } from "./components/AppHeader";
import { AgentMonitor } from "./components/AgentMonitor";
import { WorktreeManager } from "./components/WorktreeManager";
import { TaskModal } from "./components/TaskModal";
import { TaskDetail } from "./components/TaskDetail";
import { ToasterRoot } from "./components/ErrorToast";
import { ImportSettings } from "./components/ImportSettings";
import { SettingsPage, SettingsPageHandle } from "./components/SettingsPage";
import { ThemeProvider } from "./providers/ThemeProvider";
import { useBoardStore } from "./store/boardStore";
import { useRecentProjects } from "./hooks/useRecentProjects";
import { ActionBar, ActionBarAction } from "./components/ActionBar";
import { Plus, Save, RotateCcw } from "lucide-react";
import type { AppSettings, Project, Task } from "./types/bindings";
import "./App.css";

function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  // Check if Tauri is available on mount (Tauri 2 uses __TAURI__)
  console.log("[DEBUG] App.tsx: Tauri available?", typeof (window as any).__TAURI__ !== 'undefined');
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [showImportSettings, setShowImportSettings] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [activePage, setActivePage] = useState<
    "kanban" | "agents" | "worktrees" | "settings"
  >("kanban");
  const [slideDirection, setSlideDirection] = useState(1);
  const { addTask } = useBoardStore();
  const settingsPageRef = useRef<SettingsPageHandle>(null);

  // Load recent projects for filtering dropdown (AppHeader will do the filtering)
  const { recentProjects, refetch: refetchRecentProjects } = useRecentProjects();

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

  // Load all projects
  async function loadAllProjects() {
    try {
      console.log("[DEBUG] App.tsx: Loading all projects");
      const allProjects = await safeInvoke<Project[]>("get_projects");
      console.log("[DEBUG] App.tsx: Projects loaded successfully", allProjects);
      setProjects(allProjects);
    } catch (err) {
      console.error("[DEBUG] App.tsx: Failed to load projects:", err);
      setProjects([]);
    }
  }

  // Load settings from database
  async function loadSettings() {
    try {
      console.log("[DEBUG] App.tsx: Loading settings");
      const loaded = await safeInvoke<AppSettings>("get_settings");
      console.log("[DEBUG] App.tsx: Settings loaded successfully", loaded);

      // Validate and clean up recent projects
      console.log("[DEBUG] App.tsx: Validating recent projects");
      const validPaths = await safeInvoke<string[]>("validate_recent_projects");

      // Update settings with cleaned list if different
      if (JSON.stringify(validPaths) !== JSON.stringify(loaded.recent_projects)) {
        console.log("[DEBUG] App.tsx: Updating recent projects with validated list");
        loaded.recent_projects = validPaths;
        await safeInvoke("save_settings", { settings: loaded });
      }

      setSettings(loaded);
      return loaded;
    } catch (err) {
      console.error("[DEBUG] App.tsx: Failed to load settings:", err);
      const defaultSettings = {
        project_path: null,
        recent_projects: [],
        model_default: "claude-opus-4-5",
        mcp_allowlist: [],
        skills_default: [],
        theme_preference: "system",
        updated_at: new Date().toISOString(),
      };
      setSettings(defaultSettings);
      return defaultSettings;
    }
  }

  // Handle recent projects change (called when user removes a project)
  async function handleRecentProjectsChanged() {
    console.log("[DEBUG] App.tsx: Recent projects changed, reloading settings");
    await refetchRecentProjects();
    await loadSettings(); // Reload settings to keep React state in sync with database
  }

  // Load settings on mount
  useEffect(() => {
    async function initialize() {
      const loaded = await loadSettings();

      if (loaded.project_path) {
        console.log(`[DEBUG] App.tsx: Project path found in settings: ${loaded.project_path}`);
        // Load the current project from database
        try {
          console.log("[DEBUG] App.tsx: Loading project from database");
          const project = await safeInvoke<Project>("get_or_create_project", {
            path: loaded.project_path,
          });
          console.log("[DEBUG] App.tsx: Project loaded successfully", project);
          setCurrentProject(project);
        } catch (projectErr) {
          console.error("[DEBUG] App.tsx: Failed to load current project:", projectErr);
        }
      } else {
        console.log("[DEBUG] App.tsx: No project path in settings, showing ProjectPicker");
      }

      setLoading(false);
    }

    initialize();
    // Load all projects for dropdown
    loadAllProjects();
  }, []);

  async function handleProjectSelected(projectPath: string) {
    try {
      console.log(`[DEBUG] App.tsx: handleProjectSelected starting with path: ${projectPath}`);

      // Get or create project in database (safeInvoke logs all details)
      console.log("[DEBUG] App.tsx: Calling get_or_create_project");
      const project = await safeInvoke<Project>("get_or_create_project", {
        projectPath: projectPath,
      });
      console.log("[DEBUG] App.tsx: Project created/loaded successfully", project);
      setCurrentProject(project);

      const newSettings: AppSettings = {
        project_path: projectPath,
        recent_projects: settings?.recent_projects || [],
        model_default: settings?.model_default || "claude-opus-4-5",
        mcp_allowlist: settings?.mcp_allowlist || [],
        skills_default: settings?.skills_default || [],
        theme_preference: settings?.theme_preference || "system",
        updated_at: new Date().toISOString(),
      };

      // Add to recent if not already there (no limit - store all recent projects)
      if (!newSettings.recent_projects.includes(projectPath)) {
        newSettings.recent_projects.unshift(projectPath);
        // No slice - keep all recent projects for per-connection filtering
      }

      console.log("[DEBUG] App.tsx: Saving settings with new project path");
      await safeInvoke("save_settings", { settings: newSettings });
      console.log("[DEBUG] App.tsx: Settings saved successfully");

      setSettings(newSettings);

      // Reload all projects to include the newly selected one
      await loadAllProjects();

      console.log("[DEBUG] App.tsx: Project selected, main UI should now be visible");
    } catch (err) {
      console.error("[DEBUG] App.tsx: Failed in handleProjectSelected:", err);
      // Show error to user
      alert(`Failed to load project: ${err}\n\nCheck browser console for details.`);
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
  console.log("[DEBUG] App.tsx render: loading=", loading, "currentProject=", currentProject?.path || "null");
  console.log("[DEBUG] App.tsx render: recentProjects=", recentProjects.length, recentProjects.map(rp => ({path: rp.path, name: rp.name, is_remote: rp.is_remote})));
  console.log("[DEBUG] App.tsx render: projects=", projects.length, projects.map(p => ({path: p.path, name: p.name, is_remote: p.is_remote})));

  const appContent = (
    <>
      {loading ? (
        <div className="app">
          <p>Loading...</p>
        </div>
      ) : !currentProject ? (
        <ProjectPicker
          onProjectSelected={handleProjectSelected}
          onRecentProjectsChanged={handleRecentProjectsChanged}
        />
      ) : (
        <div className="app flex flex-col h-screen bg-background">
          <AppHeader
            currentProject={currentProject}
            activeView={activePage}
            onViewChange={handlePageChange}
            projects={projects}
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
                  <KanbanBoard
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
                  <AgentMonitor
                    projectId={currentProject.id}
                    agents={[]}
                    activeAgentId={null}
                  />
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
                  <WorktreeManager
                    projectId={currentProject.id}
                    worktrees={[]}
                  />
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
                  <SettingsPage ref={settingsPageRef} projectId={currentProject.id} />
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

  return (
    <ThemeProvider>
      <ToasterRoot />
      {appContent}
    </ThemeProvider>
  );
}

export default App;
