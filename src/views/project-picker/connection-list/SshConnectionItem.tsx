import { Server, ChevronRight } from "lucide-react";
import { Button } from "@/ui/button";
import { useSshConnectionStatus } from "@/services/connection.service";
import type { Connection } from "@/contexts/ConnectionContext";

export function SshConnectionItem({
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
