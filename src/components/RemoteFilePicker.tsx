import { useState, useEffect } from "react";
import { Button } from "./ui/button";
import { SshConnection } from "../types/bindings";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";
import { ChevronRight, Folder, Home, ArrowLeft } from "lucide-react";

interface RemoteFilePickerProps {
  connection: SshConnection;
  onProjectSelect: (path: string) => void;
  onBack: () => void;
}

export function RemoteFilePicker({
  connection,
  onProjectSelect,
  onBack,
}: RemoteFilePickerProps) {
  const [currentPath, setCurrentPath] = useState(`/home/${connection.username}`);
  const [directories, setDirectories] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

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
    const newPath = currentPath === "/"
      ? `/${dirName}`
      : `${currentPath}/${dirName}`;
    setCurrentPath(newPath);
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
    onProjectSelect(currentPath);
  }

  // Parse path into breadcrumb parts
  const pathParts = currentPath.split("/").filter(Boolean);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background text-foreground p-8">
      <div className="max-w-3xl w-full">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-semibold mb-3">
            Select Remote Project Directory
          </h1>
          <p className="text-base text-muted-foreground">
            Connected to {connection.connection_string}
          </p>
        </div>

        <div className="bg-card border border-border rounded-lg p-6 min-h-[500px] flex flex-col">
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

          {/* Current Path Display */}
          <div className="mb-4">
            <p className="text-xs text-muted-foreground font-mono">
              Current: {currentPath}
            </p>
          </div>

          {/* Directory List */}
          <div className="flex-1 overflow-auto mb-4">
            {loading ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                Loading directories...
              </p>
            ) : directories.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No subdirectories found
              </p>
            ) : (
              <ul className="space-y-2">
                {directories.map((dir) => (
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
                ))}
              </ul>
            )}
          </div>

          {/* Action Buttons */}
          <div className="pt-4 border-t border-border flex gap-3">
            <Button
              onClick={onBack}
              disabled={loading}
              variant="outline"
              className="flex-1"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
            <Button
              onClick={handleSelectCurrentDirectory}
              disabled={loading}
              variant="default"
              className="flex-1"
            >
              <Folder className="w-4 h-4 mr-2" />
              Select "{currentPath}"
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
