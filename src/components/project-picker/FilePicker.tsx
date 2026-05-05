import { useEffect, useCallback, useRef } from "react";
import { Button } from "@/ui/button";
import type { SshConnection } from "@/types/bindings";
import { Folder, Home, FolderUp, HardDrive, FolderOpen } from "lucide-react";
import { Switch } from "@/ui/switch";
import { Label } from "@/ui/label";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "@/ui/breadcrumb";
import {
  usePathNavigation,
  useKeyboardNavigation,
  useFilePickerInitialization,
} from "@/utils/hooks";
import { useListDirectories } from "@/services/connection.service";

interface FilePickerProps {
  connection?: SshConnection | null;
  onProjectSelect: (path: string, connectionId?: number) => void;
  loading?: boolean;
}

const DRIVES_ROOT = "<<DRIVES>>";

export function FilePicker({
  connection,
  onProjectSelect,
  loading: externalLoading = false,
}: FilePickerProps) {
  const isLocal = !connection;
  const containerRef = useRef<HTMLDivElement>(null);

  // Custom hooks handle all business logic
  const keyboard = useKeyboardNavigation();
  const { setSelectedIndex: resetKeyboardIndex } = keyboard;
  const initialization = useFilePickerInitialization(isLocal, connection);
  const navigation = usePathNavigation(isLocal, initialization.drives);
  const { data: directories = [], isLoading: directoriesLoading } = useListDirectories(
    connection?.id,
    navigation.currentPath,
  );

  // Set initial path when initialization completes
  useEffect(() => {
    if (initialization.isInitialized && initialization.initialPath && !navigation.currentPath) {
      navigation.setCurrentPath(initialization.initialPath);
    }
  }, [initialization, navigation]);

  // Filter directories based on showHidden toggle
  const visibleDirectories = initialization.showHidden
    ? directories
    : directories.filter((dir) => !dir.startsWith("."));

  // Single effect to reset keyboard selection when path changes
  useEffect(() => {
    if (initialization.isInitialized && navigation.currentPath) {
      resetKeyboardIndex(-1);
    }
  }, [navigation.currentPath, initialization.isInitialized, resetKeyboardIndex]);

  // Keyboard navigation effect
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Only handle navigation keys - don't interfere with other inputs
      if (!["ArrowDown", "ArrowUp", "Enter", "Backspace"].includes(e.key)) {
        return;
      }

      const showingDrives = isLocal && navigation.currentPath === DRIVES_ROOT;
      const itemList = showingDrives ? initialization.drives : visibleDirectories;
      const hasParent =
        !showingDrives && navigation.currentPath !== "/" && navigation.currentPath !== DRIVES_ROOT;
      const totalItems = hasParent ? itemList.length + 1 : itemList.length;

      // Arrow key navigation
      if (e.key === "ArrowDown") {
        e.preventDefault();
        keyboard.setSelectedIndex((prev) => {
          const next = prev + 1;
          return next >= totalItems ? 0 : next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        keyboard.setSelectedIndex((prev) => {
          const next = prev - 1;
          return next < 0 ? totalItems - 1 : next;
        });
      } else if (e.key === "Enter" && keyboard.selectedIndex >= 0) {
        e.preventDefault();
        // Execute the selected item
        if (hasParent && keyboard.selectedIndex === 0) {
          navigation.navigateToParent();
        } else {
          const itemIndex = hasParent ? keyboard.selectedIndex - 1 : keyboard.selectedIndex;
          const item = itemList[itemIndex];
          if (item) {
            navigation.navigateToDirectory(item);
          }
        }
      } else if (e.key === "Backspace" && !showingDrives) {
        e.preventDefault();
        navigation.navigateToParent();
      }
    }

    const container = containerRef.current;
    if (container) {
      // Focus container to receive keyboard events
      container.focus();
      container.addEventListener("keydown", handleKeyDown);
      return () => container.removeEventListener("keydown", handleKeyDown);
    }

    return undefined;
  }, [keyboard, navigation, initialization.drives, visibleDirectories, isLocal]);

  const handleSelectCurrentDirectory = useCallback(() => {
    onProjectSelect(navigation.currentPath, connection?.id);
  }, [navigation.currentPath, connection?.id, onProjectSelect]);

  // Compute loading state
  const loading = directoriesLoading || initialization.isLoading;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="flex flex-col h-full max-h-full overflow-hidden outline-none"
    >
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
                      onClick={() => navigation.navigateToBreadcrumb(-1)}
                      className="flex items-center gap-1 text-sm hover:text-accent transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded px-1 py-0.5 cursor-pointer"
                    >
                      <Home className="w-4 h-4" />
                      <span>{navigation.isDrivesRoot ? "Drives" : "Root"}</span>
                    </button>
                  )}
                />
              </BreadcrumbItem>
              {navigation.pathParts.map((part: string, index: number) => (
                <div key={index} className="contents">
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink
                      render={(props) => (
                        <button
                          {...props}
                          onClick={() => navigation.navigateToBreadcrumb(index)}
                          className="text-sm hover:text-accent transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded px-1 py-0.5 cursor-pointer"
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
              {navigation.isDrivesRoot ? (
                initialization.drives.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">No drives found</p>
                ) : (
                  initialization.drives.map((drive, index) => (
                    <button
                      key={drive}
                      ref={(el) => {
                        if (el) keyboard.directoryButtonRefs.current.set(index, el);
                        else keyboard.directoryButtonRefs.current.delete(index);
                      }}
                      onClick={() => navigation.navigateToDirectory(drive)}
                      disabled={loading}
                      className={`w-full text-left flex items-center gap-2 font-mono text-sm py-2.5 px-2 hover:bg-muted/30 hover:text-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
                        keyboard.selectedIndex === index ? "bg-accent" : ""
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
                  {navigation.currentPath !== "/" && navigation.currentPath !== DRIVES_ROOT && (
                    <button
                      ref={(el) => {
                        if (el) keyboard.directoryButtonRefs.current.set(0, el);
                        else keyboard.directoryButtonRefs.current.delete(0);
                      }}
                      onClick={navigation.navigateToParent}
                      disabled={loading}
                      className={`w-full text-left flex items-center gap-2 font-mono text-sm py-2.5 px-2 hover:bg-muted/30 hover:text-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
                        keyboard.selectedIndex === 0 ? "bg-accent" : ""
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
                      const hasParent =
                        navigation.currentPath !== "/" && navigation.currentPath !== DRIVES_ROOT;
                      const itemIndex = hasParent ? index + 1 : index;
                      return (
                        <button
                          key={dir}
                          ref={(el) => {
                            if (el) keyboard.directoryButtonRefs.current.set(itemIndex, el);
                            else keyboard.directoryButtonRefs.current.delete(itemIndex);
                          }}
                          onClick={() => navigation.navigateToDirectory(dir)}
                          disabled={loading}
                          className={`w-full text-left flex items-center gap-2 font-mono text-sm py-2.5 px-2 hover:bg-muted/30 hover:text-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
                            keyboard.selectedIndex === itemIndex ? "bg-accent" : ""
                          }`}
                        >
                          <Folder className="size-4 shrink-0" />
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
              checked={initialization.showHidden}
              onCheckedChange={(checked) => initialization.setShowHidden(checked)}
              className="focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 data-checked:bg-accent data-unchecked:bg-muted-foreground/25 dark:data-unchecked:bg-muted-foreground/25"
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
              {navigation.isDrivesRoot ? "Select a drive" : navigation.currentPath}
            </p>
          </div>

          <Button
            onClick={handleSelectCurrentDirectory}
            disabled={loading || externalLoading || navigation.isDrivesRoot}
            variant="default"
            size="default"
            className="shrink-0 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            <FolderOpen className="size-4" />
            {externalLoading ? "Opening..." : "Open"}
          </Button>
        </div>
      </div>
    </div>
  );
}
