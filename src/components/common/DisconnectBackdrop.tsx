import { Loader2, WifiOff, AlertTriangle, LogOut } from "lucide-react";
import type { ConnectionHealthState } from "@/utils/hooks/useConnectionHealth";

interface DisconnectBackdropProps {
  state: Exclude<ConnectionHealthState, "connected">;
  attempt: number;
  maxAttempts: number;
  onLeaveConnection: () => void;
}

/**
 * Full-screen blocking overlay shown when the SSH connection is lost.
 *
 * Covers the entire viewport with z-50 to prevent interaction with stale UI.
 * Shows different content based on state:
 * - "lost": Initial disconnect detection
 * - "reconnecting": Active reconnection with attempt counter
 * - "failed": All retries exhausted, user action needed
 */
export function DisconnectBackdrop({
  state,
  attempt,
  maxAttempts,
  onLeaveConnection,
}: DisconnectBackdropProps) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background/90 backdrop-blur-sm">
      {state === "failed" ? (
        <AlertTriangle className="h-8 w-8 text-destructive" />
      ) : state === "lost" ? (
        <WifiOff className="h-8 w-8 text-muted-foreground animate-pulse" />
      ) : (
        <Loader2 className="h-8 w-8 text-muted-foreground animate-spin" />
      )}
      <p className="text-sm font-medium text-foreground">
        {state === "reconnecting"
          ? `Reconnecting\u2026 (${attempt}/${maxAttempts})`
          : "SSH connection lost"}
      </p>
      <p className="text-xs text-muted-foreground max-w-xs text-center">
        {state === "failed"
          ? `Could not reconnect after ${maxAttempts} attempts. Check your network and SSH server, then try connecting again.`
          : state === "lost"
            ? "Detecting connection status\u2026"
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
