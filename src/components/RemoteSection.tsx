import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { SshConnection } from "../types/bindings";
import { Globe, Pencil } from "lucide-react";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";

interface RemoteSectionProps {
  sshConnections: SshConnection[];
  onConnectionClick: (connection: SshConnection) => void;
  onNewConnection: (connectionString: string) => void;
  onConnectionRenamed?: () => void;
  loading?: boolean;
}

export function RemoteSection({
  sshConnections,
  onConnectionClick,
  onNewConnection,
  onConnectionRenamed,
  loading = false,
}: RemoteSectionProps) {
  const [connectionString, setConnectionString] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

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

  const handleStartEdit = (connection: SshConnection) => {
    setEditingId(connection.id);
    setEditName(connection.display_name || connection.connection_string);
  };

  const handleSaveEdit = async (connectionId: number) => {
    if (!editName.trim()) {
      toast.error("Name cannot be empty");
      return;
    }

    try {
      await safeInvoke("rename_ssh_connection", {
        connectionId,
        displayName: editName.trim(),
      });
      setEditingId(null);
      if (onConnectionRenamed) {
        onConnectionRenamed();
      }
      toast.success("Connection renamed");
    } catch (error) {
      toast.error(`Failed to rename: ${error}`);
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditName("");
  };

  const handleEditKeyDown = (e: React.KeyboardEvent, connectionId: number) => {
    if (e.key === "Enter") {
      handleSaveEdit(connectionId);
    } else if (e.key === "Escape") {
      handleCancelEdit();
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-4 pb-2 border-b border-border">
        <Globe className="w-5 h-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Remote Projects</h2>
      </div>

      <div className="flex-1 overflow-auto mb-4">
        {sshConnections.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No saved SSH connections
          </p>
        ) : (
          <ul className="space-y-2">
            {sshConnections.map((connection) => (
              <li key={connection.id} className="relative group">
                {editingId === connection.id ? (
                  <div className="flex gap-2 items-center">
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => handleEditKeyDown(e, connection.id)}
                      onBlur={() => handleSaveEdit(connection.id)}
                      className="flex-1 font-mono text-sm"
                      autoFocus
                    />
                  </div>
                ) : (
                  <Button
                    onClick={() => onConnectionClick(connection)}
                    disabled={loading}
                    variant="outline"
                    className="w-full text-left justify-start font-mono text-sm h-auto py-3 px-4 pr-12"
                  >
                    <div className="flex flex-col items-start gap-1 w-full">
                      <span className="font-semibold flex items-center gap-2">
                        <Globe className="w-3 h-3" />
                        {connection.display_name || connection.connection_string}
                      </span>
                      {connection.display_name && (
                        <span className="text-xs text-muted-foreground">
                          {connection.connection_string}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        Last used: {new Date(connection.last_used_at).toLocaleDateString()}
                      </span>
                    </div>
                  </Button>
                )}
                {editingId !== connection.id && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStartEdit(connection);
                    }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="pt-4 border-t border-border space-y-3">
        <Input
          type="text"
          value={connectionString}
          onChange={(e) => setConnectionString(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="user@host:22 or user@host"
          className="font-mono text-sm"
          disabled={loading}
        />
        <Button
          onClick={handleConnect}
          disabled={loading || !connectionString.trim()}
          variant="default"
          size="lg"
          className="w-full"
        >
          <Globe className="w-4 h-4 mr-2" />
          {loading ? "Connecting..." : "Connect"}
        </Button>
      </div>
    </div>
  );
}
