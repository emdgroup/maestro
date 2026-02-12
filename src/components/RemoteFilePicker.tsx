import { useState, useEffect } from "react";
import { Button } from "./ui/button";
import { SshConnection } from "../types/bindings";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";
import { ChevronRight, Folder, Home, FolderUp } from "lucide-react";
import { Switch } from "./ui/switch";
import { Label } from "./ui/label";

interface RemoteFilePickerProps {
  connection: SshConnection;
  onProjectSelect: (path: string) => void;
}

export function RemoteFilePicker({
  connection,
  onProjectSelect,
}: RemoteFilePickerProps) {
  const [currentPath, setCurrentPath] = useState(`/home/${connection.username}`);
  const [directories, setDirectories] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    loadDirectories(currentPath);
  }, [currentPath]);

  async function loadDirectories(path: string) {
    setLoading(true);
    try {
      const dirs = await safeInvoke<string[]>("list_remote_directories", {
        connectionId: connection.id,
        path,
      });
      setDirectories(dirs);
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
    <div className="flex flex-col h-full">
      <div className="text-center p-6 pb-4">
        <h2 className="text-2xl font-semibold mb-2">
          Select Remote Project Directory
        </h2>
        <p className="text-sm text-muted-foreground">
          Connected to {connection.connection_string}
        </p>
      </div>

      <div className="flex-1 flex flex-col p-6 pt-0 min-h-[400px]">
          {/* Breadcrumb Navigation */}
          <div className="flex items-center gap-2 mb-4 pb-4 border-b border-border flex-wrap">
            <button
              onClick={() => handleBreadcrumbClick(-1)}
              className="flex items-center gap-1 text-sm hover:text-primary transition-colors"
            >
              <Home className="w-4 h-4" />
              <span>Root</span>
            </button>
            {pathParts.map((part, index) => (
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
          <div className="flex-1 overflow-y-auto mb-4 min-h-0">
            {loading ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                Loading directories...
              </p>
            ) : (
              <ul className="space-y-2">
                {/* Parent directory ".." button - only show if not at root */}
                {currentPath !== "/" && (
                  <li>
                    <Button
                      onClick={handleParentDirectory}
                      disabled={loading}
                      variant="outline"
                      className="w-full text-left justify-start font-mono text-sm h-auto py-3 px-4"
                    >
                      <FolderUp className="w-4 h-4 mr-2 flex-shrink-0" />
                      <span className="truncate">..</span>
                    </Button>
                  </li>
                )}

                {/* Subdirectories */}
                {visibleDirectories.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No subdirectories found
                  </p>
                ) : (
                  visibleDirectories.map((dir) => (
                    <li key={dir}>
                      <Button
                        onClick={() => handleDirectoryClick(dir)}
                        disabled={loading}
                        variant="outline"
                        className="w-full text-left justify-start font-mono text-sm h-auto py-3 px-4"
                      >
                        <Folder className="w-4 h-4 mr-2 flex-shrink-0" />
                        <span className="truncate">{dir}</span>
                      </Button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>

          {/* Action Bar */}
          <div className="pt-4 border-t border-border flex items-center gap-4">
            <Button
              onClick={handleSelectCurrentDirectory}
              disabled={loading}
              variant="default"
              size="default"
              className="flex-shrink-0"
            >
              <Folder className="w-4 h-4 mr-2" />
              Open project
            </Button>

            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground font-mono truncate">
                {currentPath}
              </p>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
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
          </div>
        </div>
      </div>
  );
}
