import { useEffect, useCallback, useRef, useState } from "react";
import type { SshConnection, WslConnection, DockerConnection } from "@/types/bindings";
import { Folder, Home, FolderUp, HardDrive, FolderOpen, Pencil } from "lucide-react";
import { Switch } from "@/ui/switch";
import { Label } from "@/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "@/ui/breadcrumb";
import { usePathNavigation } from "@/hooks/usePathNavigation";
import { useKeyboardNavigation } from "@/hooks/useKeyboardNavigation";
import { useFilePickerInitialization } from "@/hooks/useFilePickerInitialization";
import {
  useListDirectories,
  useWslDirectories,
  useWslHome,
  useDockerDirectories,
  useDockerHome,
} from "@/services/connection.service";

interface FilePickerProps {
  connection?: SshConnection | null;
  wslConnection?: WslConnection | null;
  dockerConnection?: DockerConnection | null;
  onProjectSelect: (
    path: string,
    connectionId?: number,
    wslConnectionId?: number,
    dockerConnectionId?: number,
  ) => void;
  loading?: boolean;
}

const DRIVES_ROOT = "<<DRIVES>>";

export function FilePicker({
  connection,
  wslConnection,
  dockerConnection,
  onProjectSelect,
  loading: externalLoading = false,
}: FilePickerProps) {
  const isLocal = !connection && !wslConnection && !dockerConnection;
  const containerRef = useRef<HTMLDivElement>(null);

  // Custom hooks handle all business logic
  const keyboard = useKeyboardNavigation();
  const { setSelectedIndex: resetKeyboardIndex } = keyboard;
  const initialization = useFilePickerInitialization(isLocal, connection);
  const { data: wslHome } = useWslHome(wslConnection?.distro_name ?? "");
  const { data: dockerHome } = useDockerHome(dockerConnection?.container_name ?? "");
  const navigation = usePathNavigation(isLocal, initialization.drives);
  const { data: sshDirectories = [], isLoading: sshLoading } = useListDirectories(
    connection?.id,
    navigation.currentPath,
  );
  const { data: wslDirectories = [], isLoading: wslLoading } = useWslDirectories(
    wslConnection?.distro_name ?? "",
    navigation.currentPath,
  );
  const { data: dockerDirectories = [], isLoading: dockerLoading } = useDockerDirectories(
    dockerConnection?.container_name ?? "",
    navigation.currentPath,
  );
  const directories = wslConnection
    ? wslDirectories
    : dockerConnection
      ? dockerDirectories
      : sshDirectories;
  const directoriesLoading = wslConnection
    ? wslLoading
    : dockerConnection
      ? dockerLoading
      : sshLoading;

  // Set initial path when initialization completes (WSL/Docker use home dir, local/SSH use standard init)
  // Latched in state rather than a ref so the render-phase read stays pure.
  const [didSetInitialPath, setDidSetInitialPath] = useState(false);
  if (!didSetInitialPath && !navigation.currentPath) {
    if (wslConnection && wslHome) {
      setDidSetInitialPath(true);
      navigation.setCurrentPath(wslHome);
    } else if (dockerConnection && dockerHome) {
      setDidSetInitialPath(true);
      navigation.setCurrentPath(dockerHome);
    } else if (
      !wslConnection &&
      !dockerConnection &&
      initialization.isInitialized &&
      initialization.initialPath
    ) {
      setDidSetInitialPath(true);
      navigation.setCurrentPath(initialization.initialPath);
    }
  }

  // The breadcrumb bar turns into a text field holding the path, as Explorer's address bar does.
  const [typedPath, setTypedPath] = useState<string | null>(null);

  // Filter directories based on showHidden toggle
  const visibleDirectories = initialization.showHidden
    ? directories
    : directories.filter((dir) => !dir.startsWith("."));

  // Reset keyboard selection when path changes
  const [prevPath, setPrevPath] = useState(navigation.currentPath);
  if (prevPath !== navigation.currentPath) {
    setPrevPath(navigation.currentPath);
    if (initialization.isInitialized) {
      resetKeyboardIndex(-1);
    }
  }

  // Keyboard navigation effect
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Only handle navigation keys - don't interfere with other inputs
      if (e.target instanceof HTMLInputElement) return;
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
      // Focus container to receive keyboard events, unless the path field already has it
      if (!container.contains(document.activeElement)) container.focus();
      container.addEventListener("keydown", handleKeyDown);
      return () => container.removeEventListener("keydown", handleKeyDown);
    }

    return undefined;
  }, [keyboard, navigation, initialization.drives, visibleDirectories, isLocal]);

  const handleSelectCurrentDirectory = useCallback(() => {
    onProjectSelect(
      navigation.currentPath,
      connection?.id,
      wslConnection?.id,
      dockerConnection?.id,
    );
  }, [
    navigation.currentPath,
    connection?.id,
    wslConnection?.id,
    dockerConnection?.id,
    onProjectSelect,
  ]);

  // Compute loading state
  const loading = directoriesLoading || initialization.isLoading;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="mt-5 flex h-[420px] flex-col overflow-hidden outline-none"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        {/* Breadcrumb Navigation, or the path being typed */}
        {typedPath !== null ? (
          <input
            autoFocus
            value={typedPath}
            onFocus={(event) => event.target.select()}
            onChange={(event) => setTypedPath(event.target.value)}
            onBlur={() => setTypedPath(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                navigation.navigateToPath(typedPath);
                setTypedPath(null);
              }
              if (event.key === "Escape") {
                // The dialog would close on the same key.
                event.stopPropagation();
                setTypedPath(null);
              }
            }}
            aria-label="Path"
            spellCheck={false}
            className="home-field h-7 shrink-0 rounded-lg px-2 font-mono text-xs"
          />
        ) : (
          <div className="group/path flex h-7 shrink-0 items-center text-xs">
            <Breadcrumb>
              <BreadcrumbList className="gap-0.5 sm:gap-0.5">
                <BreadcrumbItem>
                  <BreadcrumbLink
                    render={(props) => (
                      <button
                        {...props}
                        onClick={() => navigation.navigateToBreadcrumb(-1)}
                        className="flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-xs transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        <Home className="size-3.5" />
                        <span>{navigation.isDrivesRoot ? "Drives" : "Root"}</span>
                      </button>
                    )}
                  />
                </BreadcrumbItem>
                {navigation.pathParts.map((part: string, index: number) => (
                  <div key={index} className="contents">
                    <BreadcrumbSeparator className="text-muted-foreground/60 [&>svg]:size-3" />
                    <BreadcrumbItem>
                      <BreadcrumbLink
                        render={(props) => (
                          <button
                            {...props}
                            onClick={() => navigation.navigateToBreadcrumb(index)}
                            className="cursor-pointer rounded-md px-1 py-0.5 font-mono text-xs transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
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
            {/* The bar's empty end; the pencil shows only while the path is hovered. */}
            <Tooltip trackCursorAxis="x">
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Edit path"
                    onClick={() =>
                      setTypedPath(navigation.isDrivesRoot ? "" : navigation.currentPath)
                    }
                    className="group/edit flex h-full min-w-8 flex-1 cursor-text items-center justify-end rounded-md pr-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
                  />
                }
              >
                <Pencil className="size-3.5 opacity-0 transition-opacity group-hover/path:opacity-100 group-focus-visible/edit:opacity-100" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">Edit path</p>
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        {/* Directory List */}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-foreground/[0.07] bg-background/40 p-1.5">
          {loading ? (
            <p className="text-sm text-muted-foreground text-center py-8">Loading directories...</p>
          ) : (
            <div className="space-y-0.5">
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
                      className={`flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left font-mono text-xs transition-colors hover:bg-foreground/[0.07] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 ${
                        keyboard.selectedIndex === index ? "bg-foreground/[0.08]" : ""
                      }`}
                    >
                      <HardDrive className="size-4 shrink-0 text-muted-foreground" />
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
                      className={`flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left font-mono text-xs transition-colors hover:bg-foreground/[0.07] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 ${
                        keyboard.selectedIndex === 0 ? "bg-foreground/[0.08]" : ""
                      }`}
                    >
                      <FolderUp className="size-4 shrink-0 text-muted-foreground" />
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
                          className={`flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left font-mono text-xs transition-colors hover:bg-foreground/[0.07] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 ${
                            keyboard.selectedIndex === itemIndex ? "bg-foreground/[0.08]" : ""
                          }`}
                        >
                          <Folder className="size-4 shrink-0 text-muted-foreground" />
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
        <div className="flex shrink-0 items-center gap-4">
          <div className="flex items-center gap-2 shrink-0">
            <Switch
              id="show-hidden"
              checked={initialization.showHidden}
              onCheckedChange={(checked) => initialization.setShowHidden(checked)}
              className="focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 data-checked:bg-accent data-unchecked:bg-muted-foreground/25 dark:data-unchecked:bg-muted-foreground/25"
            />
            <Label
              htmlFor="show-hidden"
              className="cursor-pointer text-[11px] font-normal whitespace-nowrap text-muted-foreground"
            >
              Show hidden
            </Label>
          </div>

          <div className="ml-auto min-w-0">
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {navigation.isDrivesRoot ? "Select a drive" : navigation.currentPath}
            </p>
          </div>

          <button
            type="button"
            onClick={handleSelectCurrentDirectory}
            disabled={loading || externalLoading || navigation.isDrivesRoot}
            className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-primary px-4 text-xs text-primary-foreground disabled:opacity-50"
          >
            <FolderOpen className="size-3.5" />
            {externalLoading ? "Opening…" : "Choose"}
          </button>
        </div>
      </div>
    </div>
  );
}
