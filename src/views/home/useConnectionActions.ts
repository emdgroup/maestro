import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands } from "@/types/bindings";
import type { ConnectionKey } from "@/types/bindings";
import { api } from "@/lib/tauri-utils";
import { getErrorMessage } from "@/lib/error-utils";
import { useConfigStore } from "@/store/configStore";
import { connectionKeyId, useHomeStore } from "@/store/homeStore";
import type { ConnectionPhase } from "@/store/homeStore";
import type { AuthSubmission } from "./ssh-auth-modal/ssh-auth-utils";

const setPhase = (id: string, phase: ConnectionPhase) =>
  useHomeStore.getState().setPhase(id, phase);

/**
 * Attach to the connection's Maestro server: deploy it when needed, start the relay to it and
 * check the tools agents need. `replace` updates a server from another build that is in use.
 */
export async function attach(connection: ConnectionKey, replace = false) {
  const id = connectionKeyId(connection);
  setPhase(id, { kind: "connecting", step: 1 });
  const response = await commands.preflightConnection(connection, replace);
  if (response.status === "error") {
    setPhase(id, { kind: "failed", error: response.error, result: null });
    return;
  }
  useConfigStore.getState().setPreflightToolChecks(connection, response.data.tool_checks);
  setPhase(
    id,
    response.data.tool_checks.some((tool) => !tool.available)
      ? { kind: "failed", error: null, result: response.data }
      : { kind: "up" },
  );
}

/**
 * Connect: sign in to an SSH host with what it already has (agent, key, saved password) and fall
 * back to the inline password form; every other kind of connection attaches straight away.
 */
export async function connect(connection: ConnectionKey) {
  if (connection.type === "ssh") {
    setPhase(connectionKeyId(connection), { kind: "connecting", step: 0 });
    try {
      await api.connectSshWithoutCredentials(connection.id);
    } catch {
      setPhase(connectionKeyId(connection), { kind: "signin", error: null });
      return;
    }
  }
  await attach(connection);
}

export async function signIn(
  connection: Extract<ConnectionKey, { type: "ssh" }>,
  password: string,
  remember: boolean,
  host: string,
) {
  const id = connectionKeyId(connection);
  if (!password) {
    setPhase(id, { kind: "signin", error: `Enter the password for ${host}.` });
    return;
  }
  setPhase(id, { kind: "connecting", step: 0 });
  try {
    await api.connectSshWithPassword(connection.id, password, remember);
  } catch (error) {
    setPhase(id, { kind: "signin", error: getErrorMessage(error) });
    return;
  }
  await attach(connection);
}

/** Sign in to an SSH host with what the sign-in dialog collected. The caller attaches after. */
export async function signInWith(
  connection: Extract<ConnectionKey, { type: "ssh" }>,
  submission: AuthSubmission,
) {
  if (submission.method === "password")
    await api.connectSshWithPassword(connection.id, submission.password, submission.savePassword);
  if (submission.method === "key-file")
    await api.connectSshWithKey(
      connection.id,
      submission.keyPath,
      submission.passphrase ?? null,
      submission.savePassphrase,
    );
  if (submission.method === "agent") await api.connectSshWithAgent(connection.id);
}

export async function stopServer(connection: ConnectionKey) {
  await api.stopBackgroundServer(connection);
  setPhase(connectionKeyId(connection), { kind: "stopped" });
}

export async function restartServer(connection: ConnectionKey) {
  await api.stopBackgroundServer(connection);
  await attach(connection);
}

/** A relay that ends, or an SSH host that gives up reconnecting, leaves its panel unreachable. */
export function useConnectionLossEvents() {
  useEffect(() => {
    const markUnreachable = (connection: ConnectionKey) => {
      const id = connectionKeyId(connection);
      if (useHomeStore.getState().phases[id]?.kind === "up") {
        setPhase(id, { kind: "unreachable" });
      }
    };
    const unlisteners = Promise.all([
      listen<{ connection: ConnectionKey }>("acp://connection-lost", (event) =>
        markUnreachable(event.payload.connection),
      ),
      listen<number>("ssh-connection-failed", (event) =>
        markUnreachable({ type: "ssh", id: event.payload }),
      ),
    ]);
    return () => {
      void unlisteners.then((stops) => stops.forEach((stop) => stop()));
    };
  }, []);
}
