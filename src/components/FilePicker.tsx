import { useState, useEffect } from "react";
import { Button } from "./ui/button";
import { SshConnection } from "../types/bindings";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";
import { ChevronRight, Folder, Home, FolderUp, HardDrive } from "lucide-react";
import { Switch } from "./ui/switch";
import { Label } from "./ui/label";

interface FilePickerProps {
  connection?: SshConnection | null;
  onProjectSelect: (path: string) => void;
  loading?: boolean;
}

const DRIVES_ROOT = "<<DRIVES>>";

export function FilePicker({
  connection,
  onProjectSelect,
  loading: externalLoading = false,
}: FilePickerProps) {
  const isLocal = !connection;

  const [currentPath, setCurrentPath] = useState<string>("");
  const [directories, setDirectories] = useState<string[]>([]);
  const [drives, setDrives] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  // Initialize default path on mount
  useEffect(() => {
    async function initializePath() {
      if (isLocal && !isInitialized) {
        try {
          const defaultPath = await safeInvoke<string>("get_default_file_picker_path", {});
          setCurrentPath(defaultPath);
          setIsInitialized(true);
        } catch (error) {
          console.error("Failed to get default path:", error);
          setCurrentPath("/");
          setIsInitialized(true);
        }
      } else if (!isLocal && !isInitialized) {
        // For remote connections, use /home/username
        const remotePath = `/home/${connection!.username}`;
        setCurrentPath(remotePath);
        setIsInitialized(true);
      }
    }

    initializePath();
  }, [isLocal, isInitialized, connection]);

  // Load drives on Windows (local only)
  useEffect(() => {
    async function loadDrives() {
      if (isLocal && isInitialized) {
        try {
          const driveList = await safeInvoke<string[]>("list_drives", {});
          setDrives(driveList);
        } catch (error) {
          console.error("Failed to load drives:", error);
          setDrives([]);
        }
      }
    }

    loadDrives();
  }, [isLocal, isInitialized]);

  useEffect(() => {
    if (isInitialized && currentPath) {
      loadDirectories(currentPath);
    }
  }, [currentPath, isInitialized]);

  async function loadDirectories(path: string) {
    // Special case: show drives on Windows when at drives root
    if (path === DRIVES_ROOT) {
      setDirectories([]);
      return;
    }

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
    // Handle drive selection on Windows
    if (currentPath === DRIVES_ROOT) {
      setCurrentPath(dirName);
      return;
    }

    // Handle normal directory navigation
    let newPath: string;

    // Check if current path is a drive root (e.g., "C:/")
    if (/^[A-Z]:\/$/i.test(currentPath)) {
      newPath = `${currentPath}${dirName}`;
    } else if (currentPath === "/") {
      newPath = `/${dirName}`;
    } else {
      newPath = `${currentPath}/${dirName}`;
    }

    setCurrentPath(newPath);
  }

  function handleParentDirectory() {
    // Special case: at drives root, can't go up
    if (currentPath === DRIVES_ROOT) {
      return;
    }

    // Check if we're at a drive root on Windows (e.g., "C:/")
    if (isLocal && drives.length > 0 && /^[A-Z]:\/$/i.test(currentPath)) {
      // Go back to drives list
      setCurrentPath(DRIVES_ROOT);
      return;
    }

    // Unix-style or nested Windows path
    const parts = currentPath.split("/").filter(Boolean);
    if (parts.length > 0) {
      parts.pop();

      // Check if after popping, we have a drive letter (e.g., ["C:"])
      if (parts.length === 1 && /^[A-Z]:$/i.test(parts[0])) {
        setCurrentPath(`${parts[0]}/`);
      } else if (parts.length === 0) {
        // No parts left, go to root
        setCurrentPath("/");
      } else {
        // Check if first part is a Windows drive letter
        const isWindowsPath = /^[A-Z]:$/i.test(parts[0]);
        const newPath = isWindowsPath ? parts.join("/") : "/" + parts.join("/");
        setCurrentPath(newPath);
      }
    }
  }

  function handleBreadcrumbClick(index: number) {
    if (index === -1) {
      // Root click - on Windows with drives, go to drives root
      if (isLocal && drives.length > 0) {
        setCurrentPath(DRIVES_ROOT);
      } else {
        setCurrentPath("/");
      }
      return;
    }

    const parts = currentPath.split("/").filter(Boolean);
    const selectedPart = parts.slice(0, index + 1);

    // Check if we're clicking on a drive letter
    if (selectedPart.length === 1 && /^[A-Z]:$/i.test(selectedPart[0])) {
      setCurrentPath(`${selectedPart[0]}/`);
    } else {
      // Check if first part is a Windows drive letter
      const isWindowsPath = /^[A-Z]:$/i.test(selectedPart[0]);
      const newPath = isWindowsPath ? selectedPart.join("/") : "/" + selectedPart.join("/");
      setCurrentPath(newPath);
    }
  }

  function handleSelectCurrentDirectory() {
    // Always use current directory
    onProjectSelect(currentPath);
  }

  // Parse path into breadcrumb parts
  const pathParts = currentPath === DRIVES_ROOT ? [] : currentPath.split("/").filter(Boolean);

  // Check if we're showing drives
  const showingDrives = isLocal && currentPath === DRIVES_ROOT;

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
              <span>{showingDrives ? "Drives" : "Root"}</span>
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
                {/* Show drives on Windows when at drives root */}
                {showingDrives ? (
                  drives.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No drives found
                    </p>
                  ) : (
                    drives.map((drive) => (
                      <button
                        key={drive}
                        onClick={() => handleDirectoryClick(drive)}
                        disabled={loading}
                        className="w-full text-left flex items-center gap-2 font-mono text-sm py-2.5 px-2 hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <HardDrive className="w-4 h-4 shrink-0" />
                        <span className="truncate">{drive}</span>
                      </button>
                    ))
                  )
                ) : (
                  <>
                    {/* Parent directory ".." button - show unless at root or drives root */}
                    {currentPath !== "/" && currentPath !== DRIVES_ROOT && (
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
                  </>
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
                {showingDrives ? "Select a drive" : currentPath}
              </p>
            </div>

            <Button
              onClick={handleSelectCurrentDirectory}
              disabled={loading || externalLoading || showingDrives}
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
