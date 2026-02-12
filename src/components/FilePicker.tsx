import { useState, useEffect } from "react";
import { Button } from "./ui/button";
import { SshConnection } from "../types/bindings";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";
import { ChevronRight, Folder, Home, FolderUp } from "lucide-react";
import { Switch } from "./ui/switch";
import { Label } from "./ui/label";

interface FilePickerProps {
  connection?: SshConnection | null;
  onProjectSelect: (path: string) => void;
  loading?: boolean;
}

export function FilePicker({
  connection,
  onProjectSelect,
  loading: externalLoading = false,
}: FilePickerProps) {
  const isLocal = !connection;
  const defaultPath = connection ? `/home/${connection.username}` : "/home";

  const [currentPath, setCurrentPath] = useState(defaultPath);
  const [directories, setDirectories] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    loadDirectories(currentPath);
  }, [currentPath]);

  async function loadDirectories(path: string) {
    setLoading(true);
    try {
      if (isLocal) {
        const dirs = await safeInvoke<string[]>("list_local_directories", {
          path,
        });
        setDirectories(dirs);
      } else {
        const dirs = await safeInvoke<string[]>("list_remote_directories", {
          connectionId: connection!.id,
          path,
        });
        setDirectories(dirs);
      }
    } catch (error) {
      toast.error(`Failed to list directories: ${error}`);
      setDirectories([]);
    } finally {
      setLoading(false);
    }
  }

  function handleDirectoryClick(dirName: string) {
    // Single click: navigate into directory
    const newPath = currentPath === "/"
      ? `/${dirName}`
      : `${currentPath}/${dirName}`;
    setCurrentPath(newPath);
  }

  function handleParentDirectory() {
    const parts = currentPath.split("/").filter(Boolean);
    if (parts.length > 0) {
      parts.pop();
      const newPath = parts.length === 0 ? "/" : "/" + parts.join("/");
      setCurrentPath(newPath);
    }
  }

  function handleBreadcrumbClick(index: number) {
    const parts = currentPath.split("/").filter(Boolean);
    if (index === -1) {
      // Root
      setCurrentPath("/");
    } else {
      const newPath = "/" + parts.slice(0, index + 1).join("/");
      setCurrentPath(newPath);
    }
  }

  function handleSelectCurrentDirectory() {
    // Always use current directory
    onProjectSelect(currentPath);
  }

  // Parse path into breadcrumb parts
  const pathParts = currentPath.split("/").filter(Boolean);

  // Filter directories based on showHidden toggle
  const visibleDirectories = showHidden
    ? directories
    : directories.filter((dir) => !dir.startsWith("."));

  return (
    <div className="flex flex-col h-full max-h-full overflow-hidden">
      <div className="text-center p-6 pb-4 shrink-0">
        <h2 className="text-2xl font-semibold mb-2">
          Select Project Directory
        </h2>
        {connection && (
          <p className="text-sm text-muted-foreground">
            Connected to {connection.connection_string}
          </p>
        )}
      </div>

      <div className="flex-1 flex flex-col px-6 pb-6 min-h-0 overflow-hidden gap-4">
          {/* Breadcrumb Navigation */}
          <div className="flex items-center gap-2 pb-4 border-b border-border flex-wrap shrink-0">
            <button
              onClick={() => handleBreadcrumbClick(-1)}
              className="flex items-center gap-1 text-sm hover:text-primary transition-colors"
            >
              <Home className="w-4 h-4" />
              <span>Root</span>
            </button>
            {pathParts.map((part: string, index: number) => (
              <div key={index} className="flex items-center gap-2">
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
                <button
                  onClick={() => handleBreadcrumbClick(index)}
                  className="text-sm hover:text-primary transition-colors"
                >
                  {part}
                </button>
              </div>
            ))}
          </div>


          {/* Directory List */}
          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
            {loading ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                Loading directories...
              </p>
            ) : (
              <div className="divide-y divide-border">
                {/* Parent directory ".." button - only show if not at root */}
                {currentPath !== "/" && (
                  <button
                    onClick={handleParentDirectory}
                    disabled={loading}
                    className="w-full text-left flex items-center gap-2 font-mono text-sm py-2.5 px-2 hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <FolderUp className="w-4 h-4 shrink-0" />
                    <span className="truncate">..</span>
                  </button>
                )}

                {/* Subdirectories */}
                {visibleDirectories.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No subdirectories found
                  </p>
                ) : (
                  visibleDirectories.map((dir) => (
                    <button
                      key={dir}
                      onClick={() => handleDirectoryClick(dir)}
                      disabled={loading}
                      className="w-full text-left flex items-center gap-2 font-mono text-sm py-2.5 px-2 hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Folder className="w-4 h-4 shrink-0" />
                      <span className="truncate">{dir}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Action Bar */}
          <div className="border-t border-border flex items-center gap-4 shrink-0 pt-4">
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                id="show-hidden"
                checked={showHidden}
                onCheckedChange={(checked) => setShowHidden(checked)}
              />
              <Label
                htmlFor="show-hidden"
                className="text-xs font-normal cursor-pointer whitespace-nowrap"
              >
                Show hidden
              </Label>
            </div>

            <div className="ml-auto">
              <p className="text-xs text-muted-foreground font-mono truncate">
                {currentPath}
              </p>
            </div>

            <Button
              onClick={handleSelectCurrentDirectory}
              disabled={loading || externalLoading}
              variant="default"
              size="default"
              className="shrink-0"
            >
              <Folder className="w-4 h-4" />
              {externalLoading ? "Opening..." : "Open Project"}
            </Button>
          </div>
        </div>
      </div>
  );
}
