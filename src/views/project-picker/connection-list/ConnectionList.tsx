import React, { useState } from "react";
import { Folder, Server, ChevronRight, Zap, Terminal } from "lucide-react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { SshAuthModal } from "../ssh-auth-modal/SshAuthModal";
import { useSshConnectionManager } from "@/utils/hooks/useSshConnectionManager";
import { useProjectPickerNavigation } from "@/utils/hooks/useProjectPickerNavigation";
import { useSshConnectionStatus } from "@/services/connection.service";
import { useConnectionContext } from "@/contexts/ConnectionContext";
import type { Connection } from "@/contexts/ConnectionContext";

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
  const [connectionString, setConnectionString] = useState("");
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
    handleNewConnection,
    handleConnection,
    handleAuthSubmit,
    handleAuthCancel,
  } = useSshConnectionManager({ onConnectionSuccess: handleConnectionClick });

  const handleConnect = async () => {
    if (connectionString) {
      await handleNewConnection(connectionString.trim());
      setConnectionString("");
    }
  };

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && connectionString.trim()) {
      await handleConnect();
    }
  };

  return (
    <>
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-auto mb-4 px-1 py-1 custom-scrollbar">
          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No connections available
            </p>
          ) : (
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
            </ul>
          )}
        </div>

        <div className="pt-4 border-t border-border">
          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={connectionString}
              onChange={(e) => setConnectionString(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter user@host"
              className="font-mono text-sm h-auto hover:bg-background focus:bg-background inset-shadow-ring"
              disabled={loading}
            />
            <Button
              onClick={handleConnect}
              disabled={loading || !connectionString.trim()}
              variant="default"
              size="default"
              className="shrink-0"
            >
              <Zap className="w-4 h-4" />
              {loading ? "Connecting..." : "Add Connection"}
            </Button>
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
