import { useEffect, useState } from "react";
import { safeInvoke } from "./lib/tauri-safe";
import { ProjectPicker } from "./components/ProjectPicker";
import { KanbanBoard } from "./components/KanbanBoard";
import { AppHeader } from "./components/AppHeader";
import { AgentMonitor } from "./components/AgentMonitor";
import { WorktreeManager } from "./components/WorktreeManager";
import { TaskModal } from "./components/TaskModal";
import { TaskDetail } from "./components/TaskDetail";
import { ToasterRoot } from "./components/ErrorToast";
import { ImportSettings } from "./components/ImportSettings";
import { ProjectSettingsModal } from "./components/ProjectSettingsModal";
import { ThemeProvider } from "./providers/ThemeProvider";
import { useBoardStore } from "./store/boardStore";
import type { AppSettings, Project, Task } from "./types/bindings";
import "./App.css";

function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [showImportSettings, setShowImportSettings] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [activePage, setActivePage] = useState<
    "kanban" | "agents" | "worktrees" | "settings"
  >("kanban");
  const { addTask } = useBoardStore();

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

  // Load settings on mount
  useEffect(() => {
    async function loadSettings() {
      try {
        console.log("[DEBUG] App.tsx: Loading initial settings");
        const loaded = await safeInvoke<AppSettings>("get_settings");
        console.log("[DEBUG] App.tsx: Settings loaded successfully", loaded);
        setSettings(loaded);
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
      } catch (err) {
        console.error("[DEBUG] App.tsx: Failed to load settings:", err);
        setSettings({
          project_path: null,
          recent_projects: [],
          model_default: "claude-opus-4-5",
          mcp_allowlist: [],
          skills_default: [],
          theme_preference: "system",
          updated_at: new Date().toISOString(),
        });
      } finally {
        setLoading(false);
      }
    }

    loadSettings();
    // Load all projects for dropdown
    loadAllProjects();
  }, []);

  async function handleProjectSelected(projectPath: string) {
    try {
      console.log(`[DEBUG] App.tsx: handleProjectSelected starting with path: ${projectPath}`);

      // Get or create project in database (safeInvoke logs all details)
      console.log("[DEBUG] App.tsx: Calling get_or_create_project");
      const project = await safeInvoke<Project>("get_or_create_project", {
        path: projectPath,
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

      // Add to recent if not already there
      if (!newSettings.recent_projects.includes(projectPath)) {
        newSettings.recent_projects.unshift(projectPath);
        newSettings.recent_projects = newSettings.recent_projects.slice(0, 5); // Keep last 5
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
    }
  }

  function handleTaskCreated(newTask: Task) {
    addTask(newTask);
  }

  function handleImportConfigSaved() {
    // Settings saved, can now enable sync button
    setShowImportSettings(false);
  }

  const appContent = (
    <>
      {loading ? (
        <div className="app">
          <p>Loading...</p>
        </div>
      ) : !currentProject ? (
        <ProjectPicker
          onProjectSelected={handleProjectSelected}
          recentProjects={settings?.recent_projects}
        />
      ) : (
        <div className="app flex flex-col h-screen bg-background">
          <ToasterRoot />
          <AppHeader
            currentProject={currentProject}
            activeView={activePage}
            onViewChange={setActivePage}
            projects={projects}
            onProjectChange={handleProjectSelected}
            agentCount={0}
          />
          <main className="flex-1 overflow-auto">
            {/* Kanban Board Page */}
            {activePage === "kanban" && (
              <KanbanBoard
                projectId={currentProject.id}
                projectPath={currentProject.path}
                onTaskClick={setSelectedTask}
              />
            )}

            {/* Agent Monitor Page */}
            {activePage === "agents" && (
              <AgentMonitor
                projectId={currentProject.id}
                agents={[]}
                activeAgentId={null}
              />
            )}

            {/* Worktree Manager Page */}
            {activePage === "worktrees" && (
              <WorktreeManager
                projectId={currentProject.id}
                worktrees={[]}
              />
            )}

            {/* Settings Page */}
            {activePage === "settings" && (
              <div className="h-full p-4">
                <ProjectSettingsModal
                  isOpen={true}
                  onClose={() => setActivePage("kanban")}
                  projectId={currentProject.id}
                />
              </div>
            )}

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

  return <ThemeProvider>{appContent}</ThemeProvider>;
}

export default App;
