import { Plus } from "lucide-react";
import type { Connection } from "@/contexts/ConnectionContext";
import { SshConnectionItem } from "./SshConnectionItem";
import { ConnectionItem } from "./ConnectionItem";

export function ConnectionListPanel({
  connections,
  loading,
  onConnect,
  onAddClick,
}: {
  connections: Connection[];
  loading: boolean;
  onConnect: (c: Connection) => void;
  onAddClick: () => void;
}) {
  return (
    <div className="flex-1 overflow-auto px-1 py-1 custom-scrollbar">
      <ul className="space-y-2">
        {connections.map((connection) => {
          if (connection.type === "ssh" && connection.sshConnection) {
            return (
              <SshConnectionItem
                key={connection.id}
                connection={connection}
                onConnect={() => onConnect(connection)}
                loading={loading}
              />
            );
          }
          return (
            <ConnectionItem
              key={connection.id}
              connection={connection}
              onConnect={() => onConnect(connection)}
              loading={loading}
            />
          );
        })}
        <li key="add">
          <button
            type="button"
            onClick={onAddClick}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-dashed border-border/50 text-muted-foreground hover:border-border hover:text-foreground transition-colors"
          >
            <Plus className="w-4 h-4 shrink-0" />
            <span className="text-sm">Add connection</span>
          </button>
        </li>
      </ul>
    </div>
  );
}
