import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ProjectPicker } from "./components/ProjectPicker";
import { KanbanBoard } from "./components/KanbanBoard";
import type { AppSettings, Project } from "./types/bindings";
import "./App.css";

function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [projectSelected, setProjectSelected] = useState(false);
  const [loading, setLoading] = useState(true);

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
      <header className="app-header">
        <h1>GSD Agent Orchestrator</h1>
        <p>Project: {settings?.project_path}</p>
      </header>
      <main className="app-main">
        {currentProject && (
          <KanbanBoard projectId={currentProject.id} />
        )}
      </main>
    </div>
  );
}

export default App;
