import { useState } from "react";
import { Server } from "lucide-react";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { Label } from "@/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { relativeAge } from "@/components/execution/worktree-card/worktree-usage";
import {
  useBackgroundServerQuery,
  useSetBackgroundServerAutostartMutation,
  useStopBackgroundServerMutation,
} from "@/services/automation.service";
import { useSelectedProjectActions } from "@/store/projectStore";
import { useNow } from "@/hooks/useNow";
import type { Autostart, ConnectionKey } from "@/types/bindings";

const HOW_IT_STARTS: Record<Exclude<Autostart, "unsupported" | "off">, string> = {
  login: "Starts when you log in to this computer.",
  systemd: "Installed as a systemd user service, with linger, so it starts at boot.",
  cron: "Installed as a crontab @reboot line, since systemd or linger was not available.",
};

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The server that runs this connection's agents and automations, and outlives the window.
 *
 * Stop ends every session and run on it, and the project with them, since the project cannot do
 * anything without its server; opening it again starts a fresh one.
 */
export function BackgroundServerSection({ connection }: { connection: ConnectionKey }) {
  const { data: server, error } = useBackgroundServerQuery(connection);
  const autostart = useSetBackgroundServerAutostartMutation();
  const stop = useStopBackgroundServerMutation();
  const { clearSelectedProject } = useSelectedProjectActions();
  const [confirming, setConfirming] = useState(false);
  const now = useNow();

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
        <Server className="w-4 h-4 text-muted-foreground" />
        Background server
      </h3>

      <p className="text-xs text-muted-foreground">
        Runs this host's agent sessions and automations, and keeps running when Maestro is closed.
        It stops at logout or reboot unless it starts automatically, and until something starts it
        again, schedules and webhooks do not fire.
      </p>

      {server ? (
        <p className="text-xs text-emerald-600">
          Running for {relativeAge(server.started_at, now)}, version {server.version},{" "}
          {plural(server.live_sessions, "session", "sessions")},{" "}
          {plural(server.running_runs, "automation run", "automation runs")} going
        </p>
      ) : (
        error && <p className="text-xs text-destructive">{String(error)}</p>
      )}

      {server && server.autostart !== "unsupported" && (
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="server-autostart" className="text-sm">
              Start automatically
            </Label>
            <p className="text-[11px] text-muted-foreground">
              {server.autostart === "off"
                ? connection.type === "local"
                  ? "Start it when you log in to this computer, so automations run without opening Maestro."
                  : "Start it when this host boots, so automations run without opening Maestro."
                : HOW_IT_STARTS[server.autostart]}
            </p>
          </div>
          <Switch
            id="server-autostart"
            checked={server.autostart !== "off"}
            disabled={autostart.isPending}
            onCheckedChange={(enabled) => autostart.mutate({ connection, enabled })}
          />
        </div>
      )}
      {server?.autostart === "unsupported" && (
        <p className="text-[11px] text-muted-foreground">
          A WSL distro or a container does not start on its own, so this server starts when a
          project on it is opened.
        </p>
      )}

      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          disabled={!server || stop.isPending}
          onClick={() => setConfirming(true)}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          {stop.isPending ? "Stopping" : "Stop server"}
        </Button>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop the background server?</AlertDialogTitle>
            <AlertDialogDescription>
              {server && (server.live_sessions > 0 || server.running_runs > 0)
                ? `${plural(server.live_sessions, "agent session", "agent sessions")} and ${plural(server.running_runs, "automation run", "automation runs")} end with it. `
                : ""}
              Maestro disconnects and closes this project. Schedules and webhooks do not fire until
              a project on this host is opened again, which starts a new server.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                stop.mutate(connection, { onSuccess: clearSelectedProject });
              }}
            >
              Stop server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
