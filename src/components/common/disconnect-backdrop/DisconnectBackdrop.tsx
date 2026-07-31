import { Loader2, WifiOff, AlertTriangle, LogOut } from "lucide-react";
import type { ConnectionHealthState } from "@/utils/hooks/useConnectionHealth";
import type { ConnectionKey } from "@/types/bindings";

interface DisconnectBackdropProps {
  state: Exclude<ConnectionHealthState, "connected" | "quiet">;
  attempt: number;
  maxAttempts: number;
  connection: ConnectionKey;
  onLeaveConnection: () => void;
}

/// Only SSH can put itself back, so it is the only one told that anything is being attempted.
/// The rest say what happened and leave the next move to the user — offering to restart a
/// container or a distro is a capability maestro does not have yet, and implying otherwise
/// would be worse than saying nothing.
function describe(connection: ConnectionKey): { title: string; detail: string } {
  switch (connection.type) {
    case "ssh":
      return { title: "SSH connection lost", detail: "Detecting connection status…" };
    case "docker":
      return {
        title: "Container stopped",
        detail:
          "The container running this project is no longer available, and sessions on it have ended. Start it again, then reopen the project.",
      };
    case "wsl":
      return {
        title: "WSL distro stopped",
        detail:
          "The distro running this project shut down, and sessions on it have ended. Reopen the project to start it again.",
      };
    default:
      return {
        title: "Agent server stopped",
        detail: "The local maestro-server exited, and sessions have ended. Reopen the project.",
      };
  }
}

/**
 * Full-screen blocking overlay shown once a connection is actually gone, for any connection type.
 *
 * Covers the entire viewport to prevent interaction with stale UI. Deliberately not shown for
 * `quiet`, which means the server has only stopped answering — the header reports that instead.
 * - "lost": the transport ended
 * - "reconnecting": SSH backoff in progress, with attempt counter
 * - "failed": SSH retries exhausted, user action needed
 */
export function DisconnectBackdrop({
  state,
  attempt,
  maxAttempts,
  connection,
  onLeaveConnection,
}: DisconnectBackdropProps) {
  const { title, detail } = describe(connection);
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-background/90 backdrop-blur-sm">
      {state === "failed" ? (
        <AlertTriangle className="h-8 w-8 text-destructive" />
      ) : state === "lost" ? (
        <WifiOff className="h-8 w-8 text-muted-foreground animate-pulse" />
      ) : (
        <Loader2 className="h-8 w-8 text-muted-foreground animate-spin" />
      )}
      <p className="text-sm font-medium text-foreground">
        {state === "reconnecting" ? `Reconnecting\u2026 (${attempt}/${maxAttempts})` : title}
      </p>
      <p className="text-xs text-muted-foreground max-w-xs text-center">
        {state === "failed"
          ? `Could not reconnect after ${maxAttempts} attempts. Check your network and SSH server, then try connecting again.`
          : state === "lost"
            ? detail
            : "Attempting to restore the connection"}
      </p>
      <button
        onClick={onLeaveConnection}
        className="mt-2 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        <LogOut className="h-3.5 w-3.5 mr-1.5 inline" />
        Leave Connection
      </button>
    </div>
  );
}
