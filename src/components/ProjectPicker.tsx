import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";
import { RemoteConnectionForm } from "./RemoteConnectionForm";
import { SshConfig } from "../types/bindings";
import "../styles/ProjectPicker.css";

interface ProjectPickerProps {
  onProjectSelected: (path: string) => void;
  recentProjects?: string[];
}

type Stage = "select" | "local" | "remote";

export function ProjectPicker({
  onProjectSelected,
  recentProjects = [],
}: ProjectPickerProps) {
  const [stage, setStage] = useState<Stage>("select");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState("");

  async function handleSelectLocal() {
    setStage("local");
    setError(null);
  }

  async function handleSelectRemote() {
    setStage("remote");
    setError(null);
  }

  async function handleFolderPicker() {
    console.log("[DEBUG] Opening folder dialog");
    setLoading(true);
    setError(null);
    try {
      const selectedPath = await openDialog({
        directory: true,
        multiple: false,
        title: "Select Project Directory",
      });

      if (selectedPath) {
        console.log(`[DEBUG] Dialog returned path: ${selectedPath}`);
        // Validate it's a directory (Tauri handles this)
        onProjectSelected(selectedPath as string);
        console.log("[DEBUG] onProjectSelected callback invoked successfully");
      } else {
        console.log("[DEBUG] Dialog returned no path (user cancelled)");
      }
    } catch (err) {
      const errorMsg = `Failed to select folder: ${err}`;
      console.error(`[DEBUG] ${errorMsg}`, err);
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  }

  async function handleRecentProject(path: string) {
    console.log(`[DEBUG] Opening recent project: ${path}`);
    setLoading(true);
    setError(null);
    try {
      onProjectSelected(path);
      console.log("[DEBUG] Recent project callback invoked successfully");
    } catch (err) {
      const errorMsg = `Failed to open project: ${err}`;
      console.error(`[DEBUG] ${errorMsg}`, err);
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  }

  async function handleManualPath(e: React.FormEvent) {
    e.preventDefault();
    if (!manualPath.trim()) {
      console.log("[DEBUG] Manual path is empty");
      setError("Please enter a project path");
      return;
    }
    console.log(`[DEBUG] Opening manual path: ${manualPath.trim()}`);
    setLoading(true);
    setError(null);
    try {
      onProjectSelected(manualPath.trim());
      console.log("[DEBUG] Manual path callback invoked successfully");
    } catch (err) {
      const errorMsg = `Failed to open project: ${err}`;
      console.error(`[DEBUG] ${errorMsg}`, err);
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateRemote(config: SshConfig) {
    console.log(`[DEBUG] Creating remote project for host: ${config.host}`);
    setLoading(true);
    setError(null);
    try {
      // Create project with remote config (safeInvoke logs all details)
      const project = await safeInvoke<{ path: string }>("create_project", {
        name: config.host,
        path: config.remote_path,
        is_remote: true,
        ssh_config: config,
      });

      console.log(`[DEBUG] Remote project created at: ${project.path}`);
      onProjectSelected(project.path);
      console.log("[DEBUG] Remote project callback invoked successfully");
    } catch (err) {
      const errorMsg = String(err);
      console.error(`[DEBUG] Failed to create remote project: ${errorMsg}`, err);
      setError(errorMsg);
      toast.error(`Failed to create remote project: ${errorMsg}`);
    } finally {
      setLoading(false);
    }
  }

  // Stage: Select local or remote
  if (stage === "select") {
    return (
      <div className="project-picker" data-testid="project-picker">
        <div className="project-picker-container">
          <h1>Welcome to GSD Agent Orchestrator</h1>
          <p>Select a project directory to get started</p>

          <div className="project-type-selection">
            <button
              className="project-picker-button primary"
              onClick={handleSelectLocal}
              disabled={loading}
            >
              📁 Local Project
            </button>

            <button
              className="project-picker-button primary"
              onClick={handleSelectRemote}
              disabled={loading}
            >
              🌐 Remote Project (SSH)
            </button>
          </div>

          {recentProjects.length > 0 && (
            <div className="recent-projects">
              <h2>Recent Projects</h2>
              <ul>
                {recentProjects.map((project) => (
                  <li key={project}>
                    <button
                      onClick={() => handleRecentProject(project)}
                      disabled={loading}
                      className="project-picker-button secondary"
                    >
                      {project}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && <div className="error-message">{error}</div>}
        </div>
      </div>
    );
  }

  // Stage: Local project
  if (stage === "local") {
    return (
      <div className="project-picker" data-testid="project-picker-local">
        <div className="project-picker-container">
          <h1>Select Local Project</h1>

          <button
            className="project-picker-button primary"
            onClick={handleFolderPicker}
            disabled={loading}
          >
            {loading ? "Loading..." : "Select Project Folder"}
          </button>

          <div className="manual-path-section">
            <p className="manual-path-label">Or enter path manually:</p>
            <form onSubmit={handleManualPath} className="manual-path-form">
              <input
                type="text"
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                placeholder="/home/user/project-path"
                className="manual-path-input"
                disabled={loading}
              />
              <button
                type="submit"
                className="project-picker-button primary"
                disabled={loading || !manualPath.trim()}
              >
                Open
              </button>
            </form>
          </div>

          <button
            className="project-picker-button secondary"
            onClick={() => setStage("select")}
            disabled={loading}
          >
            Back
          </button>

          {error && <div className="error-message">{error}</div>}
        </div>
      </div>
    );
  }

  // Stage: Remote project
  if (stage === "remote") {
    return (
      <div className="project-picker" data-testid="project-picker-remote">
        <div className="project-picker-container">
          <RemoteConnectionForm
            onSubmit={handleCreateRemote}
            onBack={() => setStage("select")}
            loading={loading}
          />
          {error && <div className="error-message">{error}</div>}
        </div>
      </div>
    );
  }

  return null;
}
