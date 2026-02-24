import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "./ui/button";
import { SshConnection } from "../types/bindings";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";
import { Folder, Home, FolderUp, HardDrive } from "lucide-react";
import { Switch } from "./ui/switch";
import { Label } from "./ui/label";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "./ui/breadcrumb";

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
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);

  const directoryButtonRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  // Filter directories based on showHidden toggle
  const visibleDirectories = showHidden
    ? directories
    : directories.filter((dir) => !dir.startsWith("."));

  const handleDirectoryClick = useCallback(
    (dirName: string) => {
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
    },
    [currentPath],
  );

  const handleParentDirectory = useCallback(() => {
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
  }, [isLocal, currentPath, drives]);

  const loadDirectories = useCallback(
    async (path: string) => {
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
    },
    [isLocal, connection?.id],
  );

  const handleBreadcrumbClick = useCallback(
    (index: number) => {
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
    },
    [isLocal, drives, currentPath],
  );

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

    void initializePath();
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

    void loadDrives();
  }, [isLocal, isInitialized]);

  useEffect(() => {
    if (isInitialized && currentPath) {
      void loadDirectories(currentPath);
      setSelectedIndex(-1); // Reset selection when path changes
    }
  }, [currentPath, isInitialized, loadDirectories]);

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const showingDrives = isLocal && currentPath === DRIVES_ROOT;
      const itemList = showingDrives ? drives : visibleDirectories;
      const hasParent = !showingDrives && currentPath !== "/" && currentPath !== DRIVES_ROOT;
      const totalItems = hasParent ? itemList.length + 1 : itemList.length;

      // Arrow key navigation
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = prev + 1;
          return next >= totalItems ? 0 : next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = prev - 1;
          return next < 0 ? totalItems - 1 : next;
        });
      } else if (e.key === "Enter" && selectedIndex >= 0) {
        e.preventDefault();
        // Execute the selected item
        if (hasParent && selectedIndex === 0) {
          handleParentDirectory();
        } else {
          const itemIndex = hasParent ? selectedIndex - 1 : selectedIndex;
          const item = itemList[itemIndex];
          if (item) {
            handleDirectoryClick(item);
          }
        }
      } else if (e.key === "Backspace" && !showingDrives) {
        e.preventDefault();
        handleParentDirectory();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    selectedIndex,
    currentPath,
    drives,
    directories,
    showHidden,
    isLocal,
    handleDirectoryClick,
    handleParentDirectory,
    visibleDirectories,
  ]);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex >= 0) {
      const button = directoryButtonRefs.current.get(selectedIndex);
      if (button) {
        button.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }, [selectedIndex]);

  function handleSelectCurrentDirectory() {
    // Always use current directory
    onProjectSelect(currentPath);
  }

  // Parse path into breadcrumb parts
  const pathParts = currentPath === DRIVES_ROOT ? [] : currentPath.split("/").filter(Boolean);

  // Check if we're showing drives
  const showingDrives = isLocal && currentPath === DRIVES_ROOT;

  return (
    <div className="flex flex-col h-full max-h-full overflow-hidden">
      <div className="text-center p-6 pb-4 shrink-0">
        <h2 className="text-2xl font-semibold mb-2">Select Project Directory</h2>
        {connection && (
          <p className="text-sm text-muted-foreground">
            Connected to {connection.connection_string}
          </p>
        )}
      </div>

      <div className="flex-1 flex flex-col px-6 pb-6 min-h-0 overflow-hidden gap-4">
        {/* Breadcrumb Navigation */}
        <div className="pb-4 border-b border-border shrink-0">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink
                  render={(props) => (
                    <button
                      {...props}
                      onClick={() => handleBreadcrumbClick(-1)}
                      className="flex items-center gap-1 text-sm hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded px-1 py-0.5"
                    >
                      <Home className="w-4 h-4" />
                      <span>{showingDrives ? "Drives" : "Root"}</span>
                    </button>
                  )}
                />
              </BreadcrumbItem>
              {pathParts.map((part: string, index: number) => (
                <div key={index} className="contents">
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink
                      render={(props) => (
                        <button
                          {...props}
                          onClick={() => handleBreadcrumbClick(index)}
                          className="text-sm hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded px-1 py-0.5"
                        >
                          {part}
                        </button>
                      )}
                    />
                  </BreadcrumbItem>
                </div>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        </div>

        {/* Directory List */}
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          {loading ? (
            <p className="text-sm text-muted-foreground text-center py-8">Loading directories...</p>
          ) : (
            <div className="divide-y divide-border">
              {/* Show drives on Windows when at drives root */}
              {showingDrives ? (
                drives.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">No drives found</p>
                ) : (
                  drives.map((drive, index) => (
                    <button
                      key={drive}
                      ref={(el) => {
                        if (el) directoryButtonRefs.current.set(index, el);
                        else directoryButtonRefs.current.delete(index);
                      }}
                      onClick={() => handleDirectoryClick(drive)}
                      disabled={loading}
                      className={`w-full text-left flex items-center gap-2 font-mono text-sm py-2.5 px-2 hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
                        selectedIndex === index ? "bg-accent" : ""
                      }`}
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
                      ref={(el) => {
                        if (el) directoryButtonRefs.current.set(0, el);
                        else directoryButtonRefs.current.delete(0);
                      }}
                      onClick={handleParentDirectory}
                      disabled={loading}
                      className={`w-full text-left flex items-center gap-2 font-mono text-sm py-2.5 px-2 hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
                        selectedIndex === 0 ? "bg-accent" : ""
                      }`}
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
                    visibleDirectories.map((dir, index) => {
                      const hasParent = currentPath !== "/" && currentPath !== DRIVES_ROOT;
                      const itemIndex = hasParent ? index + 1 : index;
                      return (
                        <button
                          key={dir}
                          ref={(el) => {
                            if (el) directoryButtonRefs.current.set(itemIndex, el);
                            else directoryButtonRefs.current.delete(itemIndex);
                          }}
                          onClick={() => handleDirectoryClick(dir)}
                          disabled={loading}
                          className={`w-full text-left flex items-center gap-2 font-mono text-sm py-2.5 px-2 hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
                            selectedIndex === itemIndex ? "bg-accent" : ""
                          }`}
                        >
                          <Folder className="w-4 h-4 shrink-0" />
                          <span className="truncate">{dir}</span>
                        </button>
                      );
                    })
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
              className="focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
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
            variant="accent"
            size="default"
            className="shrink-0 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            <Folder className="w-4 h-4" />
            {externalLoading ? "Opening..." : "Open Project"}
          </Button>
        </div>
      </div>
    </div>
  );
}
