import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { SshConnection } from "../types/bindings";
import { Folder, Server, Globe, ChevronRight, Zap } from "lucide-react";

export type ConnectionType = "local" | "ssh";

export interface Connection {
  type: ConnectionType;
  id: string | number;
  displayName: string;
  subtitle?: string;
  metadata?: string;
  sshConnection?: SshConnection;
}

interface ConnectionListProps {
  connections: Connection[];
  onConnectionClick: (connection: Connection) => void;
  onNewConnection: (connectionString: string) => void;
  loading?: boolean;
}

export function ConnectionList({
  connections,
  onConnectionClick,
  onNewConnection,
  loading = false,
}: ConnectionListProps) {
  const [connectionString, setConnectionString] = useState("");

  const handleConnect = () => {
    if (connectionString.trim()) {
      onNewConnection(connectionString.trim());
      setConnectionString("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && connectionString.trim()) {
      handleConnect();
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-4 pb-2 border-b border-border">
        <Globe className="w-5 h-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Connections</h2>
      </div>

      <div className="flex-1 overflow-auto mb-4 px-1 py-1">
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No connections available
          </p>
        ) : (
          <ul className="space-y-2">
            {connections.map((connection) => {
              const Icon = connection.type === "local" ? Folder : Server;

              return (
                <li key={connection.id} className="relative">
                  <Button
                    onClick={() => onConnectionClick(connection)}
                    disabled={loading}
                    variant="outline"
                    className="w-full text-left justify-start font-mono text-sm h-auto py-3 px-4 pr-10"
                  >
                    <div className="flex items-start gap-2 w-full">
                      <Icon className="w-4 h-4 mt-0.5 shrink-0" />
                      <div className="flex flex-col items-start gap-1 flex-1 min-w-0">
                        <span className="font-semibold">
                          {connection.displayName}
                        </span>
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
            className="font-mono text-sm h-auto bg-background border-5 border-solid border-transparent"
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
  );
}
