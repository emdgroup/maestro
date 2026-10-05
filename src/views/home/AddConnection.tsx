import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, Container, Loader2, Server, SquareTerminal } from "lucide-react";
import type { ConnectionKey, SshAuthMethod } from "@/types/bindings";
import { api } from "@/lib/tauri-utils";
import { getErrorMessage } from "@/lib/error-utils";
import { cn } from "@/lib/utils";
import {
  connectionQueryKeys,
  dockerQueryKeys,
  useDockerConnections,
  useDockerContainers,
  useWslConnections,
  useWslDistros,
  wslQueryKeys,
} from "@/services/connection.service";
import { connectionKeyId, useHomeStore } from "@/store/homeStore";
import { HomeSheet } from "./HomeSheet";
import { attach } from "./useConnectionActions";

type Kind = "ssh" | "wsl" | "docker";
type Auth = "agent" | "key" | "password";

const KINDS: { kind: Kind; label: string; Icon: typeof Server }[] = [
  { kind: "ssh", label: "SSH host", Icon: Server },
  { kind: "wsl", label: "WSL distro", Icon: SquareTerminal },
  { kind: "docker", label: "Container", Icon: Container },
];

const BUTTON = "h-9 cursor-pointer rounded-xl bg-primary px-4 text-xs text-primary-foreground";

/** The checklist an added connection goes through, read from its phase on Home. */
function Checklist({
  target,
  host,
  error,
}: {
  target: string;
  host: string;
  error: string | null;
}) {
  const phase = useHomeStore((s) => s.phases[target]);
  // Reaching the host comes before the connection has a phase; the attach then installs and
  // starts the server in one call, so those two steps finish together.
  const step = !phase ? 0 : phase.kind === "connecting" ? 1 : 4;
  const steps = [`Reaching ${host}`, "Installing the Maestro server", "Starting it", "Ready"];
  return (
    <div className="space-y-2.5 py-1">
      {steps.map((label, index) => (
        <div
          key={label}
          className={cn("flex items-center gap-3 text-sm", index > step && "text-muted-foreground")}
        >
          <span className="grid w-4 place-items-center">
            {index < step ? (
              <Check className="size-4 text-emerald-600" />
            ) : index === step && !error ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <span className="inline-block size-1.5 rounded-full bg-foreground/20" />
            )}
          </span>
          {label}
        </div>
      ))}
      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
}

function SshForm({
  onConnect,
}: {
  onConnect: (run: () => Promise<ConnectionKey>, host: string) => void;
}) {
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [auth, setAuth] = useState<Auth>("agent");
  const [keyPath, setKeyPath] = useState("~/.ssh/id_ed25519");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);

  const authMethod: SshAuthMethod =
    auth === "agent"
      ? "Agent"
      : auth === "key"
        ? { KeyFile: { path: keyPath, save_passphrase: false } }
        : { Password: { save_password: remember } };

  const submit = () =>
    onConnect(async () => {
      const id = await api.createSshConnection(address.trim(), authMethod);
      try {
        if (auth === "agent") await api.connectSshWithAgent(id);
        if (auth === "key") await api.connectSshWithKey(id, keyPath, null, false);
        if (auth === "password") await api.connectSshWithPassword(id, password, remember);
      } catch (error) {
        // Never confirmed, so it is not kept.
        await api.deleteSshConnection(id).catch(console.error);
        throw error;
      }
      if (name.trim()) await api.renameSshConnection(id, name.trim());
      return { type: "ssh", id };
    }, address.trim());

  return (
    <div className="mt-5">
      <label className="text-[11px] text-muted-foreground">
        Address
        <input
          autoFocus
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="user@host or user@host:port"
          className="home-field mt-1 h-11 w-full rounded-xl px-3.5 font-mono text-sm text-foreground"
        />
      </label>
      <label className="mt-4 block text-[11px] text-muted-foreground">
        Name <span className="opacity-60">(optional)</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Shown on the home page, defaults to the host"
          className="home-field mt-1 h-9 w-full rounded-xl px-3 text-xs text-foreground"
        />
      </label>
      <div className="mt-4 text-[11px] text-muted-foreground">Sign in with</div>
      <div className="mt-1 grid grid-cols-3 gap-1 rounded-xl border border-foreground/10 bg-background/45 p-1 text-xs">
        {(
          [
            ["agent", "SSH agent"],
            ["key", "Key file"],
            ["password", "Password"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setAuth(value)}
            className={cn(
              "h-8 cursor-pointer rounded-lg",
              auth === value
                ? "bg-card/90 font-medium shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mt-2 min-h-[44px] text-xs text-muted-foreground">
        {auth === "agent" &&
          "Uses the keys your SSH agent already holds. Nothing is stored by Maestro."}
        {auth === "key" && (
          <div className="flex gap-2">
            <input
              value={keyPath}
              onChange={(event) => setKeyPath(event.target.value)}
              aria-label="Key file"
              className="home-field h-9 flex-1 rounded-xl px-3 font-mono text-foreground"
            />
            <button
              type="button"
              onClick={async () => {
                const picked = await openDialog({ multiple: false, directory: false });
                if (typeof picked === "string") setKeyPath(picked);
              }}
              className="home-pill h-9 cursor-pointer rounded-xl px-3"
            >
              Browse…
            </button>
          </div>
        )}
        {auth === "password" && (
          <>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              className="home-field h-9 w-full rounded-xl px-3 text-foreground"
            />
            <label className="mt-2 flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
              />
              Remember in the system keychain
            </label>
          </>
        )}
      </div>
      <div className="mt-4 flex items-center">
        <span className="text-[11px] text-muted-foreground">
          Maestro installs its server on the host the first time.
        </span>
        <button
          type="button"
          disabled={!address.trim()}
          onClick={submit}
          className={cn(BUTTON, "ml-auto disabled:opacity-50")}
        >
          Connect
        </button>
      </div>
    </div>
  );
}

function WslList({
  onConnect,
}: {
  onConnect: (run: () => Promise<ConnectionKey>, host: string) => void;
}) {
  const { data: distros = [] } = useWslDistros();
  const { data: saved = [] } = useWslConnections();
  return (
    <div className="mt-5">
      <div className="mb-2 text-xs text-muted-foreground">Distributions found on this PC</div>
      <div className="space-y-1.5">
        {distros.map((distro) => {
          const taken = saved.some((connection) => connection.distro_name === distro.name);
          return (
            <button
              key={distro.name}
              type="button"
              disabled={taken}
              onClick={() =>
                onConnect(async () => {
                  const connection = await api.saveWslConnection(distro.name, null);
                  return { type: "wsl", id: connection.id };
                }, distro.name)
              }
              className={cn(
                "home-pane flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-left",
                taken ? "cursor-default opacity-50" : "cursor-pointer",
              )}
            >
              <SquareTerminal className="size-4" />
              <span className="font-medium">{distro.name}</span>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {taken ? "already added" : distro.state}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ContainerList({
  onConnect,
}: {
  onConnect: (run: () => Promise<ConnectionKey>, host: string) => void;
}) {
  const { data: containers = [], isError } = useDockerContainers();
  const { data: saved = [] } = useDockerConnections();
  return (
    <div className="mt-5">
      <div className="mb-2 text-xs text-muted-foreground">
        {isError ? "No containers found. Is Docker or Podman running?" : "Containers"}
      </div>
      <div className="space-y-1.5">
        {containers.map((container) => {
          const taken = saved.some((connection) => connection.container_name === container.name);
          const usable = !taken && container.state === "Running";
          return (
            <button
              key={container.id}
              type="button"
              disabled={!usable}
              onClick={() =>
                onConnect(async () => {
                  const connection = await api.saveDockerConnection(
                    container.name,
                    container.image,
                    null,
                  );
                  return { type: "docker", id: connection.id };
                }, container.name)
              }
              className={cn(
                "home-pane flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-left",
                usable ? "cursor-pointer" : "cursor-default opacity-50",
              )}
            >
              <Container className="size-4" />
              <span>
                <span className="block font-medium">{container.name}</span>
                <span className="block font-mono text-[11px] text-muted-foreground">
                  {container.image}
                </span>
              </span>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {taken ? "already added" : container.state}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The Add a connection panel and its dialog. Connecting turns the dialog into a checklist (reach
 * the host, install and start the Maestro server), which closes once the new panel is attached.
 */
export function AddConnectionPanel() {
  const queryClient = useQueryClient();
  const { data: distros = [] } = useWslDistros();
  const { isError: noContainers } = useDockerContainers();
  const [kind, setKind] = useState<Kind | null>(null);
  const [connecting, setConnecting] = useState<{ host: string; target: string | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const targetPhase = useHomeStore((s) =>
    connecting?.target ? s.phases[connecting.target] : undefined,
  );

  useEffect(() => {
    if (targetPhase?.kind === "up" || targetPhase?.kind === "failed") {
      // The panel takes it from here, failure included.
      const timer = setTimeout(() => {
        setKind(null);
        setConnecting(null);
      }, 700);
      return () => clearTimeout(timer);
    }
  }, [targetPhase]);

  const close = () => {
    setKind(null);
    setConnecting(null);
    setError(null);
  };

  const run = async (add: () => Promise<ConnectionKey>, host: string) => {
    setError(null);
    setConnecting({ host, target: null });
    try {
      const key = await add();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: connectionQueryKeys.list() }),
        queryClient.invalidateQueries({ queryKey: wslQueryKeys.connections() }),
        queryClient.invalidateQueries({ queryKey: dockerQueryKeys.connections() }),
      ]);
      setConnecting({ host, target: connectionKeyId(key) });
      await attach(key);
    } catch (failure) {
      setError(getErrorMessage(failure));
    }
  };

  const offered = KINDS.filter(
    ({ kind: offer }) => offer === "ssh" || (offer === "wsl" ? distros.length > 0 : !noContainers),
  );
  const title = KINDS.find((entry) => entry.kind === kind)?.label ?? "";

  return (
    <section id="add-connection" className="home-glass rounded-[22px] p-5">
      <div className="text-sm font-medium">Add a connection</div>
      <div className="mt-0.5 text-xs text-muted-foreground">Where your project lives</div>
      <div className="mt-4 flex gap-2">
        {offered.map(({ kind: offer, label, Icon }) => (
          <button
            key={offer}
            type="button"
            onClick={() => setKind(offer)}
            className="home-pane flex cursor-pointer items-center gap-2 rounded-xl px-4 py-2.5 text-xs"
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>

      <HomeSheet
        open={kind !== null}
        onOpenChange={(open) => !open && close()}
        eyebrow="Add a connection"
        title={title}
      >
        {connecting ? (
          <div className="mt-5">
            <Checklist target={connecting.target ?? ""} host={connecting.host} error={error} />
            {error && (
              <div className="mt-4 flex justify-end">
                <button type="button" className={BUTTON} onClick={() => setConnecting(null)}>
                  Back
                </button>
              </div>
            )}
          </div>
        ) : kind === "ssh" ? (
          <SshForm onConnect={(add, host) => void run(add, host)} />
        ) : kind === "wsl" ? (
          <WslList onConnect={(add, host) => void run(add, host)} />
        ) : kind === "docker" ? (
          <ContainerList onConnect={(add, host) => void run(add, host)} />
        ) : null}
      </HomeSheet>
    </section>
  );
}
