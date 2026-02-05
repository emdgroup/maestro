import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import "../styles/ProjectPicker.css";

interface ProjectPickerProps {
  onProjectSelected: (path: string) => void;
  recentProjects?: string[];
}

export function ProjectPicker({
  onProjectSelected,
  recentProjects = [],
}: ProjectPickerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState("");

  async function handleFolderPicker() {
    setLoading(true);
    setError(null);
    try {
      const selectedPath = await openDialog({
        directory: true,
        multiple: false,
        title: "Select Project Directory",
      });

      if (selectedPath) {
        // Validate it's a directory (Tauri handles this)
        onProjectSelected(selectedPath as string);
      }
    } catch (err) {
      setError(`Failed to select folder: ${err}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleRecentProject(path: string) {
    setLoading(true);
    setError(null);
    try {
      onProjectSelected(path);
    } catch (err) {
      setError(`Failed to open project: ${err}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleManualPath(e: React.FormEvent) {
    e.preventDefault();
    if (!manualPath.trim()) {
      setError("Please enter a project path");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      onProjectSelected(manualPath.trim());
    } catch (err) {
      setError(`Failed to open project: ${err}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="project-picker">
      <div className="project-picker-container">
        <h1>Welcome to GSD Agent Orchestrator</h1>
        <p>Select a project directory to get started</p>

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
