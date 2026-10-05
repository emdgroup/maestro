import { useState, type ReactNode } from "react";
import { Check, Container, Loader2, Monitor, Pencil, Server, SquareTerminal } from "lucide-react";
import type {
  ConnectionKey,
  DockerConnection,
  SshConnection,
  WslConnection,
} from "@/types/bindings";
import { useUpdateSshConnection } from "@/services/connection.service";
import { useHomeStore } from "@/store/homeStore";
import type { ConnectionPhase } from "@/store/homeStore";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { AddProjectTile, ProjectChip, ProjectTile, projectStatus } from "./ProjectTile";
import type { ProjectCard } from "./ProjectTile";
import { attach, connect, signIn } from "./useConnectionActions";

/** A connection as Home lists it. */
export interface HomeConnection {
  key: ConnectionKey;
  /** `connectionKeyId(key)`, the id phases and minimized state are kept under. */
  id: string;
  name: string;
  /** The host under the name: the machine, `user@host`, `WSL`, or the container's image. */
  detail: string;
  ssh?: SshConnection;
  wsl?: WslConnection;
  docker?: DockerConnection;
}

const ICONS = { local: Monitor, ssh: Server, wsl: SquareTerminal, docker: Container };

const SERVER_BUSY = "server_busy: ";

const setPhase = (id: string, phase: ConnectionPhase) =>
  useHomeStore.getState().setPhase(id, phase);

export interface ConnectionPanelProps {
  connection: HomeConnection;
  phase: ConnectionPhase;
  /** Null until the first summary arrives. */
  projects: ProjectCard[] | null;
  runningAutomations: number;
  minimized: boolean;
  onToggleMinimized: () => void;
  openingProject: number | null;
  onOpenProject: (project: ProjectCard) => void;
  onRemoveProject: (project: ProjectCard) => void;
  onAddProject: () => void;
  menu: ReactNode;
}

function Spinner() {
  return <Loader2 className="size-3.5 animate-spin" />;
}

/** The three steps of attaching, inline under the header. */
function ConnectingSteps({ connection, step }: { connection: HomeConnection; step: number }) {
  const steps = [
    connection.key.type === "ssh" ? "Signing in" : `Reaching ${connection.name}`,
    "Reaching the Maestro server",
    "Reading projects",
  ];
  return (
    <div className="mt-4 flex items-center gap-5 text-xs">
      {steps.map((label, index) => (
        <span
          key={label}
          className={cn("flex items-center gap-1.5", index > step && "text-muted-foreground")}
        >
          {index < step ? (
            <Check className="size-3.5 text-emerald-600" />
          ) : index === step ? (
            <Spinner />
          ) : (
            <span className="inline-block size-1.5 rounded-full bg-foreground/20" />
          )}
          {label}
        </span>
      ))}
    </div>
  );
}

function SignInForm({
  connection,
  error,
}: {
  connection: HomeConnection & { key: { type: "ssh" } };
  error: string | null;
}) {
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const host = connection.detail;
  return (
    <form
      className="mt-4 max-w-[520px] animate-in fade-in-0 slide-in-from-top-1"
      onSubmit={(event) => {
        event.preventDefault();
        void signIn(connection.key, password, remember, host);
      }}
    >
      <div key={error ?? ""} className={cn("flex gap-2", error && "animate-shake")}>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={`Password for ${host}`}
          aria-label={`Password for ${host}`}
          className="home-field h-10 flex-1 rounded-xl px-3.5 text-sm"
        />
        <button
          type="submit"
          className="h-10 cursor-pointer rounded-xl bg-primary px-4 text-xs text-primary-foreground"
        >
          Sign in
        </button>
        <button
          type="button"
          onClick={() => setPhase(connection.id, { kind: "idle" })}
          className="h-10 cursor-pointer rounded-xl px-3 text-xs text-muted-foreground hover:bg-foreground/10"
        >
          Cancel
        </button>
      </div>
      <div className="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          Remember in the system keychain
        </label>
        {error ? (
          <span className="text-rose-600 dark:text-rose-400">{error}</span>
        ) : (
          <span>Or use a key: ⋯ › Change sign-in</span>
        )}
      </div>
    </form>
  );
}

/** A connect that stopped short: the server is busy with another build, or tools are missing. */
function FailedBody({
  connection,
  phase,
}: {
  connection: HomeConnection;
  phase: Extract<ConnectionPhase, { kind: "failed" }>;
}) {
  const busy = phase.error?.startsWith(SERVER_BUSY);
  const missing = phase.result?.tool_checks.filter((tool) => !tool.available) ?? [];
  const pill =
    "home-pill cursor-pointer rounded-full px-3 py-1.5 text-xs text-foreground hover:bg-foreground/10";
  return (
    <div className="mt-4 space-y-2 text-xs text-muted-foreground">
      {phase.error && (
        <p className="text-rose-600 dark:text-rose-400">
          {busy ? phase.error.slice(SERVER_BUSY.length) : phase.error}
        </p>
      )}
      {missing.length > 0 && (
        <p>
          Missing on {connection.name}: {missing.map((tool) => tool.tool).join(", ")}. Agents that
          need them will not start. Set their paths in Settings.
        </p>
      )}
      <div className="flex gap-2">
        {busy && (
          <button type="button" className={pill} onClick={() => void attach(connection.key, true)}>
            Update anyway
          </button>
        )}
        {missing.length > 0 && !phase.error && (
          <button
            type="button"
            className={pill}
            onClick={() => setPhase(connection.id, { kind: "up" })}
          >
            Continue anyway
          </button>
        )}
        <button type="button" className={pill} onClick={() => void connect(connection.key)}>
          Try again
        </button>
      </div>
    </div>
  );
}

function ConnectionName({ connection }: { connection: HomeConnection }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(connection.name);
  const { mutate: rename } = useUpdateSshConnection();
  const save = () => {
    const name = draft.trim();
    if (connection.ssh && name && name !== connection.name) {
      rename({ connectionId: connection.ssh.id, displayName: name });
    }
    setEditing(false);
  };
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onFocus={(event) => event.target.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
          if (event.key === "Escape") setEditing(false);
        }}
        aria-label="Connection name"
        className="home-field -ml-2 h-7 w-60 rounded-lg px-2 text-lg font-semibold tracking-[-0.025em]"
      />
    );
  }
  return (
    <div className="flex items-center gap-1">
      <div className="text-lg leading-tight font-semibold tracking-[-0.025em]">
        {connection.name}
      </div>
      {connection.ssh && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Rename"
                onClick={() => {
                  setDraft(connection.name);
                  setEditing(true);
                }}
                className="grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/panel:opacity-100 hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100"
              />
            }
          >
            <Pencil className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>
            <p className="text-xs">Rename</p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * One connection on Home. Connected, it lists its projects as tiles (or as one line of chips when
 * minimized); otherwise it is the header alone with a Connect pill, or the state of the attach.
 */
export function ConnectionPanel({
  connection,
  phase,
  projects,
  runningAutomations,
  minimized,
  onToggleMinimized,
  openingProject,
  onOpenProject,
  onRemoveProject,
  onAddProject,
  menu,
}: ConnectionPanelProps) {
  const Icon = ICONS[connection.key.type];
  const up = phase.kind === "up";

  const status =
    phase.kind === "up" ? (
      runningAutomations > 0 ? (
        <span>
          {runningAutomations} automation{runningAutomations > 1 ? "s" : ""} running
        </span>
      ) : null
    ) : phase.kind === "connecting" ? (
      <span>Connecting…</span>
    ) : phase.kind === "stopped" ? (
      <span>Server stopped</span>
    ) : phase.kind === "signin" || phase.kind === "failed" ? (
      <span>Not connected</span>
    ) : phase.kind === "unreachable" ? (
      <span className="text-rose-600 dark:text-rose-400">Unreachable</span>
    ) : null;

  let body: ReactNode = null;
  if (up && projects === null) {
    body = <ConnectingSteps connection={connection} step={2} />;
  } else if (up && projects && minimized) {
    body = (
      <div
        className="mt-3 flex animate-in gap-2 overflow-hidden fade-in-0"
        style={{ maskImage: "linear-gradient(to right, #000 92%, transparent)" }}
      >
        {[...projects]
          .sort((a, b) => projectStatus(a).rank - projectStatus(b).rank)
          .map((project) => (
            <ProjectChip
              key={project.path}
              project={project}
              onOpen={() => onOpenProject(project)}
            />
          ))}
      </div>
    );
  } else if (up && projects) {
    body = (
      <div
        className="mt-4 grid animate-in gap-3 fade-in-0 slide-in-from-top-1"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}
      >
        {projects.map((project) => (
          <ProjectTile
            key={project.path}
            project={project}
            opening={openingProject !== null && openingProject === project.projectId}
            onOpen={() => onOpenProject(project)}
            onRemove={() => onRemoveProject(project)}
          />
        ))}
        <AddProjectTile onClick={onAddProject} />
      </div>
    );
  } else if (phase.kind === "signin" && connection.key.type === "ssh") {
    body = (
      <SignInForm
        connection={connection as HomeConnection & { key: { type: "ssh" } }}
        error={phase.error}
      />
    );
  } else if (phase.kind === "connecting") {
    body = <ConnectingSteps connection={connection} step={phase.step} />;
  } else if (phase.kind === "failed") {
    body = <FailedBody connection={connection} phase={phase} />;
  } else if (phase.kind === "stopped") {
    body = (
      <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
        <span>The Maestro server is stopped. Nothing runs here until it starts.</span>
        <button
          type="button"
          onClick={() => void attach(connection.key)}
          className="home-pill cursor-pointer rounded-full px-3 py-1.5 text-foreground hover:bg-foreground/10"
        >
          Start
        </button>
      </div>
    );
  } else if (phase.kind === "unreachable") {
    body = (
      <div className="mt-4 text-xs text-muted-foreground">
        Not answering. Its projects keep their state and come back when it does.
      </div>
    );
  }

  return (
    <section
      id={`connection-${connection.id}`}
      onClick={(event) => {
        // A click on the panel itself, not on anything in it, folds it to one line of chips.
        if (!up || (event.target as Element).closest("a,button,input,form,[role=menu]")) return;
        onToggleMinimized();
      }}
      className={cn(
        "group/panel home-glass rounded-[22px] p-5",
        phase.kind !== "idle" && "col-span-2",
        up && "cursor-pointer",
        (phase.kind === "stopped" || phase.kind === "unreachable") && "opacity-75",
      )}
    >
      <div className="flex items-center gap-3">
        <span className="home-pill grid size-9 place-items-center rounded-xl text-muted-foreground">
          <Icon className="size-[17px]" />
        </span>
        <div className="min-w-0">
          <ConnectionName connection={connection} />
          <div className="text-[11px] text-muted-foreground">{connection.detail}</div>
        </div>
        <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
          {phase.kind === "idle" ? (
            <button
              type="button"
              onClick={() => void connect(connection.key)}
              className="home-pill cursor-pointer rounded-full px-3 py-1.5 text-foreground hover:bg-foreground/10"
            >
              Connect
            </button>
          ) : (
            <>
              {status}
              {menu}
            </>
          )}
        </div>
      </div>
      {body}
    </section>
  );
}
