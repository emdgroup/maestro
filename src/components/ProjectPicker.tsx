import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";
import { RemoteConnectionForm } from "./RemoteConnectionForm";
import { SshConfig } from "../types/bindings";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useRecentProjects } from "../hooks/useRecentProjects";

interface ProjectPickerProps {
  onProjectSelected: (path: string) => void;
  recentProjects?: string[];
}

type Stage = "select" | "local" | "remote";

export function ProjectPicker({
  onProjectSelected,
}: ProjectPickerProps) {
  const [stage, setStage] = useState<Stage>("select");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState("");

  // Load enhanced recent projects with metadata
  const { recentProjects: enhancedRecentProjects, loading: recentLoading } = useRecentProjects();

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
      <div className="flex items-center justify-center h-screen bg-background text-foreground" data-testid="project-picker">
        <div className="max-w-lg text-center px-5 py-10">
          <h1 className="text-3xl font-semibold mb-3">Welcome to GSD Agent Orchestrator</h1>
          <p className="text-base text-muted-foreground mb-8">Select a project directory to get started</p>

          <div className="flex flex-col gap-4 my-8">
            <Button
              variant="default"
              size="lg"
              onClick={handleSelectLocal}
              disabled={loading}
              className="w-full text-base"
            >
              📁 Local Project
            </Button>

            <Button
              variant="default"
              size="lg"
              onClick={handleSelectRemote}
              disabled={loading}
              className="w-full text-base"
            >
              🌐 Remote Project (SSH)
            </Button>
          </div>

          {!recentLoading && enhancedRecentProjects.length > 0 && (
            <div className="mt-10 text-left">
              <h2 className="text-xs uppercase text-muted-foreground mb-4 tracking-wide">Recent Projects</h2>
              <ul className="list-none p-0">
                {enhancedRecentProjects.map((project) => (
                  <li key={project.path} className="mb-2">
                    <Button
                      onClick={() => handleRecentProject(project.path)}
                      disabled={loading}
                      variant="outline"
                      className="w-full text-left justify-start font-mono text-sm"
                    >
                      <span className="mr-2">
                        {project.is_remote ? '🌐' : '📁'}
                      </span>
                      <div className="flex flex-col items-start">
                        <span className="font-semibold">{project.name}</span>
                        {project.is_remote && project.host && (
                          <span className="text-xs text-muted-foreground">
                            {project.username}@{project.host}
                          </span>
                        )}
                      </div>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && <div className="mt-5 p-3 bg-destructive/10 text-destructive rounded border border-destructive/30 text-sm">{error}</div>}
        </div>
      </div>
    );
  }

  // Stage: Local project
  if (stage === "local") {
    return (
      <div className="flex items-center justify-center h-screen bg-background text-foreground" data-testid="project-picker-local">
        <div className="max-w-lg text-center px-5 py-10">
          <h1 className="text-3xl font-semibold mb-8">Select Local Project</h1>

          <Button
            variant="default"
            size="lg"
            onClick={handleFolderPicker}
            disabled={loading}
            className="w-full min-w-[200px] text-base mb-8"
          >
            {loading ? "Loading..." : "Select Project Folder"}
          </Button>

          <div className="mt-8 pt-8 border-t border-border">
            <p className="mb-4 text-muted-foreground text-sm">Or enter path manually:</p>
            <form onSubmit={handleManualPath} className="flex gap-3 items-center">
              <Input
                type="text"
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                placeholder="/home/user/project-path"
                className="flex-1 font-mono text-sm"
                disabled={loading}
              />
              <Button
                type="submit"
                variant="default"
                disabled={loading || !manualPath.trim()}
                className="min-w-[100px]"
              >
                Open
              </Button>
            </form>
          </div>

          <Button
            variant="outline"
            onClick={() => setStage("select")}
            disabled={loading}
            className="w-full mt-8"
          >
            Back
          </Button>

          {error && <div className="mt-5 p-3 bg-destructive/10 text-destructive rounded border border-destructive/30 text-sm">{error}</div>}
        </div>
      </div>
    );
  }

  // Stage: Remote project
  if (stage === "remote") {
    return (
      <div className="flex items-center justify-center h-screen bg-background text-foreground" data-testid="project-picker-remote">
        <div className="max-w-lg px-5 py-10">
          <RemoteConnectionForm
            onSubmit={handleCreateRemote}
            onBack={() => setStage("select")}
            loading={loading}
          />
          {error && <div className="mt-5 p-3 bg-destructive/10 text-destructive rounded border border-destructive/30 text-sm">{error}</div>}
        </div>
      </div>
    );
  }

  return null;
}
