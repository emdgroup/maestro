import { useState } from "react";
import { Folder, Server, ChevronRight, ChevronLeft, Terminal, Container, Plus } from "lucide-react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { SshAuthModal } from "../ssh-auth-modal/SshAuthModal";
import { useSshConnectionManager } from "@/utils/hooks/useSshConnectionManager";
import { useProjectPickerNavigation } from "@/utils/hooks/useProjectPickerNavigation";
import {
  useSshConnectionStatus,
  useDockerContainers,
  useSaveDockerConnection,
  useDockerConnections,
  useWslDistros,
  useWslConnections,
  useSaveWslConnection,
} from "@/services/connection.service";
import { useConnectionContext } from "@/contexts/ConnectionContext";
import type { Connection } from "@/contexts/ConnectionContext";

type Screen = "list" | "type-picker" | "ssh-form" | "wsl-picker" | "container-picker";

function SshConnectionItem({
  connection,
  onConnect,
  loading,
}: {
  connection: Connection;
  onConnect: () => void;
  loading: boolean;
}) {
  const { connected } = useSshConnectionStatus(connection.sshConnection!.id);

  return (
    <li className="relative">
      <Button
        onClick={onConnect}
        disabled={loading || !connected}
        variant="outline"
        className="w-full text-left justify-start font-mono text-sm h-auto py-3 px-4 pr-10 hover:bg-background hover:border-accent hover:text-accent dark:hover:border-accent dark:hover:text-accent dark:bg-background! shadow-md"
      >
        <div className="flex items-start gap-2 w-full">
          <div className="relative shrink-0">
            <Server className="w-4 h-4 mt-0.5" />
            <span
              title={connected ? "Connected" : "Not connected"}
              className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ring-1 ring-background ${
                connected ? "bg-emerald-500" : "bg-muted-foreground/40"
              }`}
            />
          </div>
          <div className="flex flex-col items-start gap-1 flex-1 min-w-0">
            <span className="font-semibold">{connection.displayName}</span>
            {connection.subtitle && (
              <span className="text-xs text-muted-foreground truncate w-full">
                {connection.subtitle}
              </span>
            )}
            {connection.metadata && (
              <span className="text-xs text-muted-foreground">{connection.metadata}</span>
            )}
          </div>
        </div>
        <ChevronRight className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
      </Button>
    </li>
  );
}

export function ConnectionList() {
  const [screen, setScreen] = useState<Screen>("list");
  const [connString, setConnString] = useState("");
  const { navigateToProjects } = useProjectPickerNavigation();
  const { startPreflight } = useConnectionContext();

  const handleConnectionClick = (connection: Connection) => {
    navigateToProjects(connection);
    void startPreflight(connection);
  };

  const {
    username,
    connections,
    savedKeyFiles,
    loading,
    showAuthModal,
    handleConnection,
    handleNewConnection,
    handleAuthSubmit,
    handleAuthCancel,
  } = useSshConnectionManager({ onConnectionSuccess: handleConnectionClick });

  const { data: wslDistros = [] } = useWslDistros();
  const { data: wslConnections = [] } = useWslConnections();
  const saveWsl = useSaveWslConnection();
  const savedDistroNames = new Set(wslConnections.map((c) => c.distro_name));

  const {
    data: containers = [],
    isLoading: containersLoading,
    isError: containerCliMissing,
  } = useDockerContainers();
  const { data: dockerConnections = [] } = useDockerConnections();
  const saveDocker = useSaveDockerConnection();
  const savedContainerNames = new Set(dockerConnections.map((c) => c.container_name));

  const panelOffset = screen === "list" ? 0 : screen === "type-picker" ? -(100 / 3) : -(200 / 3);

  return (
    <>
      <div className="h-full overflow-hidden">
        <div
          className="flex h-full transition-transform duration-300 ease-in-out"
          style={{
            width: "300%",
            transform: `translateX(${panelOffset}%)`,
          }}
        >
          {/* Panel 0 — Connection list */}
          <div className="w-1/3 h-full flex flex-col min-w-0">
            <div className="flex-1 overflow-auto px-1 py-1 custom-scrollbar">
              <ul className="space-y-2">
                {connections.map((connection) => {
                  if (connection.type === "ssh" && connection.sshConnection) {
                    return (
                      <SshConnectionItem
                        key={connection.id}
                        connection={connection}
                        onConnect={() => handleConnection(connection)}
                        loading={loading}
                      />
                    );
                  }

                  const icon =
                    connection.type === "wsl" ? (
                      <Terminal className="w-4 h-4 mt-0.5 shrink-0" />
                    ) : connection.type === "docker" ? (
                      <Container className="w-4 h-4 mt-0.5 shrink-0" />
                    ) : (
                      <Folder className="w-4 h-4 mt-0.5 shrink-0" />
                    );

                  return (
                    <li key={connection.id} className="relative">
                      <Button
                        onClick={() => handleConnection(connection)}
                        disabled={loading}
                        variant="outline"
                        className="w-full text-left justify-start font-mono text-sm h-auto py-3 px-4 pr-10 hover:bg-background hover:border-accent hover:text-accent dark:hover:border-accent dark:hover:text-accent dark:bg-background! shadow-md"
                      >
                        <div className="flex items-start gap-2 w-full">
                          {icon}
                          <div className="flex flex-col items-start gap-1 flex-1 min-w-0">
                            <span className="font-semibold">{connection.displayName}</span>
                            {connection.subtitle && (
                              <span className="text-xs text-muted-foreground truncate w-full">
                                {connection.subtitle}
                              </span>
                            )}
                            {connection.metadata && (
                              <span className="text-xs text-muted-foreground">
                                {connection.metadata}
                              </span>
                            )}
                          </div>
                        </div>
                        <ChevronRight className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      </Button>
                    </li>
                  );
                })}
                <li key="add">
                  <button
                    type="button"
                    onClick={() => setScreen("type-picker")}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-dashed border-border/50 text-muted-foreground hover:border-border hover:text-foreground transition-colors"
                  >
                    <Plus className="w-4 h-4 shrink-0" />
                    <span className="text-sm">Add connection</span>
                  </button>
                </li>
              </ul>
            </div>
          </div>

          {/* Panel 1 — Type picker */}
          <div className="w-1/3 h-full flex flex-col min-w-0">
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
              <button
                type="button"
                onClick={() => setScreen("list")}
                className="p-1 -ml-1 rounded hover:bg-muted/50 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-sm font-medium">Add connection</span>
            </div>
            <div className="flex-1 overflow-auto">
              <button
                type="button"
                onClick={() => setScreen("ssh-form")}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors"
              >
                <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                  <Server className="w-4 h-4" />
                </div>
                <div className="flex-1 text-left min-w-0">
                  <div className="text-sm font-medium">SSH</div>
                  <div className="text-xs text-muted-foreground">
                    Remote server via key or password
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>
              {wslDistros.length > 0 && (
                <button
                  type="button"
                  onClick={() => setScreen("wsl-picker")}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors"
                >
                  <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                    <Terminal className="w-4 h-4" />
                  </div>
                  <div className="flex-1 text-left min-w-0">
                    <div className="text-sm font-medium">WSL</div>
                    <div className="text-xs text-muted-foreground">Windows Subsystem for Linux</div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                </button>
              )}
              {!containerCliMissing && (
                <button
                  type="button"
                  onClick={() => setScreen("container-picker")}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors"
                >
                  <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                    <Container className="w-4 h-4" />
                  </div>
                  <div className="flex-1 text-left min-w-0">
                    <div className="text-sm font-medium">Container</div>
                    <div className="text-xs text-muted-foreground">Docker, Podman, or nerdctl</div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                </button>
              )}
            </div>
          </div>

          {/* Panel 2 — Detail */}
          <div className="w-1/3 h-full flex flex-col min-w-0">
            {screen === "ssh-form" && (
              <>
                <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
                  <button
                    type="button"
                    onClick={() => setScreen("type-picker")}
                    className="p-1 -ml-1 rounded hover:bg-muted/50 transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-sm font-medium">Add SSH</span>
                </div>
                <div className="flex-1 flex flex-col gap-4 p-4">
                  <div className="space-y-1.5">
                    <label className="text-xs text-muted-foreground font-medium">
                      Connection string
                    </label>
                    <Input
                      placeholder="user@host or user@host:port"
                      value={connString}
                      onChange={(e) => setConnString(e.target.value)}
                    />
                  </div>
                </div>
                <div className="p-4 border-t border-border shrink-0">
                  <Button
                    className="w-full"
                    size="sm"
                    disabled={!connString.trim() || loading}
                    onClick={() => {
                      setScreen("list");
                      setConnString("");
                      handleNewConnection(connString.trim());
                    }}
                  >
                    {loading ? "Adding..." : "Add"}
                  </Button>
                </div>
              </>
            )}
            {screen === "wsl-picker" && (
              <>
                <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
                  <button
                    type="button"
                    onClick={() => setScreen("type-picker")}
                    className="p-1 -ml-1 rounded hover:bg-muted/50 transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-sm font-medium">WSL</span>
                </div>
                <div className="flex-1 overflow-auto custom-scrollbar">
                  {wslDistros.map((distro) => {
                    const isSaved = savedDistroNames.has(distro.name);
                    return (
                      <button
                        key={distro.name}
                        type="button"
                        disabled={isSaved || saveWsl.isPending}
                        onClick={() =>
                          saveWsl.mutate(
                            { distroName: distro.name, displayName: null },
                            { onSuccess: () => setScreen("list") },
                          )
                        }
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                          <Terminal className="w-4 h-4" />
                        </div>
                        <div className="flex-1 text-left min-w-0">
                          <div className="text-sm font-medium">{distro.name}</div>
                        </div>
                        {isSaved && (
                          <span className="text-xs text-muted-foreground px-1.5 py-0.5 rounded bg-muted">
                            saved
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            {screen === "container-picker" && (
              <>
                <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
                  <button
                    type="button"
                    onClick={() => setScreen("type-picker")}
                    className="p-1 -ml-1 rounded hover:bg-muted/50 transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-sm font-medium">Container</span>
                </div>
                <div className="flex-1 overflow-auto custom-scrollbar">
                  {containersLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <div className="w-5 h-5 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
                    </div>
                  ) : containers.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center px-4 py-8">
                      No containers found. Is Docker/Podman running?
                    </p>
                  ) : (
                    containers.map((container) => {
                      const isSaved = savedContainerNames.has(container.name);
                      const isStopped = container.state === "Stopped";
                      const isDisabled = isSaved || isStopped || saveDocker.isPending;
                      return (
                        <button
                          key={container.id}
                          type="button"
                          disabled={isDisabled}
                          onClick={() =>
                            saveDocker.mutate(
                              {
                                containerName: container.name,
                                imageName: container.image ?? null,
                                displayName: null,
                              },
                              { onSuccess: () => setScreen("list") },
                            )
                          }
                          className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors disabled:opacity-50 ${
                            isStopped ? "cursor-not-allowed" : ""
                          }`}
                        >
                          <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                            <Container className="w-4 h-4" />
                          </div>
                          <div className="flex-1 text-left min-w-0">
                            <div className="text-sm font-medium truncate">{container.name}</div>
                            {container.image && (
                              <div className="text-xs text-muted-foreground truncate">
                                {container.image}
                              </div>
                            )}
                          </div>
                          {isSaved && (
                            <span className="text-xs text-muted-foreground px-1.5 py-0.5 rounded bg-muted">
                              saved
                            </span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <SshAuthModal
        open={showAuthModal}
        username={username}
        savedKeyFiles={savedKeyFiles}
        onSubmit={handleAuthSubmit}
        onCancel={handleAuthCancel}
        loading={loading}
      />
    </>
  );
}
