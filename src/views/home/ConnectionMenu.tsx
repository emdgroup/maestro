import { useState } from "react";
import { KeyRound, Play, RotateCcw, Settings, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Button } from "@/ui/button";
import { getErrorMessage } from "@/lib/error-utils";
import type { ConnectionPhase } from "@/store/homeStore";
import type { HomeConnection } from "./ConnectionPanel";
import type { ProjectCard } from "./ProjectTile";
import { HomeSheet } from "./HomeSheet";
import { attach, connect, restartServer, stopServer } from "./useConnectionActions";

/** `3d 6h`, `4h 12m`, `9m`. */
export function formatUptime(startedAt: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

type Confirm = "stop" | "restart" | "remove";

interface ConnectionMenuProps {
  connection: HomeConnection;
  phase: ConnectionPhase;
  projects: ProjectCard[] | null;
  server: { version: string; startedAt: string } | null;
  onSettings: () => void;
  onChangeSignIn: () => void;
  /** Absent for This computer, which cannot be removed. */
  onRemove?: () => Promise<void>;
}

function itemClass(danger?: boolean) {
  return danger
    ? "gap-2.5 rounded-[10px] px-2.5 py-1.5 text-rose-600 focus:bg-rose-500/10 focus:text-rose-600"
    : "gap-2.5 rounded-[10px] px-2.5 py-1.5 focus:bg-foreground/[0.08] focus:text-foreground";
}

/**
 * The `⋯` menu of a connection: its server's state in the header, then what can be done to it.
 * Stop, Restart and Remove confirm first, listing what each would interrupt.
 */
export function ConnectionMenu({
  connection,
  phase,
  projects,
  server,
  onSettings,
  onChangeSignIn,
  onRemove,
}: ConnectionMenuProps) {
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const up = phase.kind === "up";

  const state =
    up && server
      ? `Maestro server ${server.version} · up ${formatUptime(server.startedAt)}`
      : phase.kind === "stopping"
        ? "Stopping server"
        : phase.kind === "connecting" && phase.starting
          ? "Starting server"
          : phase.kind === "stopped"
            ? "Server stopped"
            : phase.kind === "unreachable"
              ? "Not answering"
              : "Not connected";

  const working = (projects ?? []).reduce((sum, project) => sum + project.working, 0);
  const holders = [
    ...new Set((projects ?? []).flatMap((project) => (project.holder ? [project.holder] : []))),
  ];
  const consequences: [string, string][] = [];
  if (confirm === "restart") {
    if (working)
      consequences.push([
        `${working} agent${working > 1 ? "s" : ""} stop mid-task`,
        "Their tasks resume where they were when the server is back.",
      ]);
    consequences.push(["Everything resumes on its own", "Nothing is lost, sessions are reloaded."]);
  } else if (confirm && (confirm === "stop" || up)) {
    if (working)
      consequences.push([
        `${working} agent${working > 1 ? "s" : ""} stop mid-task`,
        "Their tasks resume where they were when the server is back.",
      ]);
    consequences.push([
      "Task pipelines pause on every project here",
      "Queued tasks wait until the server runs again.",
    ]);
    if (holders.length)
      consequences.push(["Other windows lose their projects", holders.join(", ")]);
  }

  const copy = {
    stop: {
      title: `Stop the server on ${connection.name}?`,
      note: "It starts again the next time you open a project here.",
      action: "Stop server",
    },
    restart: {
      title: `Restart the server on ${connection.name}?`,
      note: "Takes a few seconds. Work picks up where it stopped.",
      action: "Restart",
    },
    remove: {
      title: `Remove ${connection.name} from Maestro?`,
      note: `Projects and their boards stay on ${connection.detail}. Adding the connection again brings them back.`,
      action: "Remove",
    },
  };

  const run = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm === "stop") await stopServer(connection.key);
      if (confirm === "restart") await restartServer(connection.key);
      if (confirm === "remove") await onRemove?.();
      setConfirm(null);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`${connection.name} actions`}
          className="grid size-7 cursor-pointer place-items-center rounded-full hover:bg-foreground/10 data-popup-open:bg-foreground/10 data-popup-open:text-foreground"
        >
          ⋯
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="home-pop w-64 rounded-2xl bg-transparent p-1.5 ring-0"
        >
          <div className="px-2.5 pt-1.5 pb-2">
            <div className="text-xs font-medium">{connection.name}</div>
            <div className="text-[11px] text-muted-foreground">{state}</div>
          </div>
          <DropdownMenuSeparator />
          {phase.kind === "unreachable" && (
            <DropdownMenuItem className={itemClass()} onClick={() => void connect(connection.key)}>
              <RotateCcw /> Try again
            </DropdownMenuItem>
          )}
          {phase.kind === "stopped" && (
            <DropdownMenuItem className={itemClass()} onClick={() => void attach(connection.key)}>
              <Play /> Start server
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className={itemClass()} onClick={onSettings}>
            <Settings />
            <span className="flex-1">Settings</span>
            <span className="text-[11px] text-muted-foreground">Agents, capacity, webhooks</span>
          </DropdownMenuItem>
          {connection.ssh && phase.kind !== "signin" && (
            <DropdownMenuItem className={itemClass()} onClick={onChangeSignIn}>
              <KeyRound />
              <span className="flex-1">Change sign-in</span>
              <span className="text-[11px] text-muted-foreground">
                {connection.ssh.auth_method === "Agent"
                  ? "Agent"
                  : "Password" in connection.ssh.auth_method
                    ? "Password"
                    : "Key file"}
              </span>
            </DropdownMenuItem>
          )}
          {up && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className={itemClass()} onClick={() => setConfirm("restart")}>
                <RotateCcw /> Restart server
              </DropdownMenuItem>
              <DropdownMenuItem className={itemClass(true)} onClick={() => setConfirm("stop")}>
                <Square /> Stop server
              </DropdownMenuItem>
            </>
          )}
          {onRemove && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className={itemClass(true)} onClick={() => setConfirm("remove")}>
                <Trash2 /> Remove connection
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <HomeSheet
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        strong
        className="sm:max-w-[480px]"
        title={confirm ? copy[confirm].title : ""}
      >
        <ul className="mt-3 space-y-2 text-sm">
          {consequences.map(([line, detail]) => (
            <li key={line} className="flex gap-2.5">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/40" />
              <span>
                <span className="block">{line}</span>
                <span className="block text-xs text-muted-foreground">{detail}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 text-xs text-muted-foreground">{confirm && copy[confirm].note}</div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void run()}
            disabled={busy}
            className={confirm === "restart" ? "" : "bg-rose-600 text-white hover:bg-rose-600/90"}
          >
            {confirm && copy[confirm].action}
          </Button>
        </div>
      </HomeSheet>
    </>
  );
}
