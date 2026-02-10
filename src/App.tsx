import { useEffect, useState } from "react";
import { invoke } from "./lib/tauri-mock";
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
  const [projectSelected, setProjectSelected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [showImportSettings, setShowImportSettings] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [activePage, setActivePage] = useState("kanban");
  const { addTask } = useBoardStore();

  // Load settings on mount
  useEffect(() => {
    async function loadSettings() {
      try {
        const loaded = await invoke<AppSettings>("get_settings");
        setSettings(loaded);
        if (loaded.project_path) {
          setProjectSelected(true);
          // Load the current project from database
          try {
            const project = await invoke<Project>("get_or_create_project", {
              path: loaded.project_path,
            });
            setCurrentProject(project);
          } catch (projectErr) {
            console.error("Failed to load current project:", projectErr);
          }
        }
      } catch (err) {
        console.error("Failed to load settings:", err);
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
  }, []);

  async function handleProjectSelected(projectPath: string) {
    try {
      // Get or create project in database
      const project = await invoke<Project>("get_or_create_project", {
        path: projectPath,
      });
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

      await invoke("save_settings", { settings: newSettings });
      setSettings(newSettings);
      setProjectSelected(true);
    } catch (err) {
      console.error("Failed to save settings:", err);
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
      ) : !projectSelected ? (
        <ProjectPicker
          onProjectSelected={handleProjectSelected}
          recentProjects={settings?.recent_projects}
        />
      ) : (
        <div className="app flex flex-col h-screen bg-background">
          <ToasterRoot />
          <AppHeader
            currentProject={currentProject}
            activePage={activePage}
            onPageChange={setActivePage}
            agentsRunning={0}
            worktreesCount={0}
          />
          <main className="flex-1 overflow-auto">
            {currentProject && (
              <>
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
              </>
            )}
          </main>
        </div>
      )}
    </>
  );

  return <ThemeProvider>{appContent}</ThemeProvider>;
}

export default App;
