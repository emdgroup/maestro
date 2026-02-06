import { useEffect, useState } from "react";
import { invoke } from "./lib/tauri-mock";
import { ProjectPicker } from "./components/ProjectPicker";
import { KanbanBoard } from "./components/KanbanBoard";
import { TaskModal } from "./components/TaskModal";
import { TaskDetail } from "./components/TaskDetail";
import { ToasterRoot } from "./components/ErrorToast";
import { ImportSettings } from "./components/ImportSettings";
import { SyncButton } from "./components/SyncButton";
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
  const { addTask, loadTasks } = useBoardStore();

  // Load settings on mount
  useEffect(() => {
    async function loadSettings() {
      try {
        const loaded = await invoke<AppSettings>("get_settings");
        setSettings(loaded);
        if (loaded.project_path) {
          setProjectSelected(true);
        }
      } catch (err) {
        console.error("Failed to load settings:", err);
        setSettings({
          project_path: null,
          recent_projects: [],
          model_default: "claude-opus-4-5",
          mcp_defaults: null,
          skills_defaults: null,
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
        mcp_defaults: settings?.mcp_defaults || null,
        skills_defaults: settings?.skills_defaults || null,
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

  async function handleSyncComplete() {
    // Reload tasks from the database after sync
    if (currentProject) {
      try {
        const tasks = await invoke<Task[]>('get_tasks', {
          project_id: currentProject.id,
        });
        loadTasks(tasks);
      } catch (error) {
        console.error('Failed to reload tasks after sync:', error);
      }
    }
  }

  function handleImportConfigSaved() {
    // Settings saved, can now enable sync button
    setShowImportSettings(false);
  }

  if (loading) {
    return (
      <div className="app">
        <p>Loading...</p>
      </div>
    );
  }

  if (!projectSelected) {
    return (
      <ProjectPicker
        onProjectSelected={handleProjectSelected}
        recentProjects={settings?.recent_projects}
      />
    );
  }

  return (
    <div className="app">
      <ToasterRoot />
      <header className="app-header">
        <div className="header-left">
          <h1>GSD Agent Orchestrator</h1>
          <p>Project: {settings?.project_path}</p>
        </div>
        <div className="header-right">
          {projectSelected && currentProject && (
            <>
              <button
                onClick={() => setShowImportSettings(true)}
                className="btn-settings"
                title="Import Settings"
              >
                ⚙️ Import Settings
              </button>
              {currentProject && (
                <SyncButton
                  projectId={currentProject.id}
                  onSyncComplete={handleSyncComplete}
                />
              )}
              <button
                onClick={() => setShowNewTaskModal(true)}
                className="btn-new-task"
              >
                + New Task
              </button>
            </>
          )}
        </div>
      </header>
      <main className="app-main">
        {currentProject && (
          <>
            <KanbanBoard
              projectId={currentProject.id}
              projectPath={currentProject.path}
              onTaskClick={setSelectedTask}
            />
            <TaskModal
              isOpen={showNewTaskModal}
              onClose={() => setShowNewTaskModal(false)}
              projectId={currentProject.id}
              onTaskCreated={handleTaskCreated}
            />
            <TaskDetail
              task={selectedTask}
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
  );
}

export default App;
