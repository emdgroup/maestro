import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import type { ConnectionKey } from "@/types/bindings";
import { connectionKeysEqual } from "@/lib/connection-utils";

/**
 * - `connected`  — nothing wrong
 * - `quiet`      — the server stopped answering but its transport is still open. A suspicion, not
 *                  a failure: an agent mid-thought or a paused container looks exactly like this,
 *                  so this state must not block the UI.
 * - `lost`       — the transport ended. Definite, and for anything but SSH it is terminal.
 * - `reconnecting` / `failed` — SSH only, driven by its own backoff loop.
 */
export type ConnectionHealthState = "connected" | "quiet" | "lost" | "reconnecting" | "failed";

interface ReconnectingPayload {
  connection_id: number;
  attempt: number;
  max_attempts: number;
}

interface ConnectionEvent {
  connection: ConnectionKey;
}

interface ConnectionHealth {
  state: ConnectionHealthState;
  attempt: number;
  maxAttempts: number;
  dismiss: () => void;
}

/**
 * Health of the connection a project lives on, for every connection type.
 *
 * Two independent signals feed this, and they are deliberately not merged:
 *
 * - `acp://connection-stale` / `-live` come from the ping watchdog, which runs for every
 *   transport. Detection there takes 25-40s and can be a false alarm, so it only ever produces
 *   `quiet`.
 * - `acp://connection-lost` fires when the transport itself ends, which is immediate and
 *   unambiguous. SSH is excluded because its heartbeat owns that case and can recover from it.
 */
export function useConnectionHealth(connection: ConnectionKey | null): ConnectionHealth {
  const [state, setState] = useState<ConnectionHealthState>("connected");
  const [attempt, setAttempt] = useState(0);
  const [maxAttempts, setMaxAttempts] = useState(5);

  const dismiss = useCallback(() => {
    setState("connected");
    setAttempt(0);
  }, []);

  // Depending on the object identity would resubscribe on every render, since callers build the
  // key inline from the project.
  const connectionId = connection && connection.type !== "local" ? connection.id : null;
  const connectionType = connection?.type ?? null;

  useEffect(() => {
    if (connection == null) {
      setState("connected");
      return;
    }
    const mine = (other: ConnectionKey) => connectionKeysEqual(connection, other);

    const sshId = connection.type === "ssh" ? connection.id : null;

    const unlisteners = Promise.all([
      listen<ConnectionEvent>("acp://connection-stale", (event) => {
        // Never escalates on its own — a quiet connection is still reachable, and the UI shows
        // this without blocking.
        if (mine(event.payload.connection)) setState((s) => (s === "connected" ? "quiet" : s));
      }),
      listen<ConnectionEvent>("acp://connection-live", (event) => {
        if (mine(event.payload.connection)) setState((s) => (s === "quiet" ? "connected" : s));
      }),
      listen<ConnectionEvent>("acp://connection-lost", (event) => {
        if (mine(event.payload.connection)) setState("lost");
      }),

      // SSH keeps its own vocabulary: it is the only transport that can put itself back.
      listen<number>("ssh-connection-lost", (event) => {
        if (event.payload === sshId) setState("lost");
      }),
      listen<ReconnectingPayload>("ssh-reconnecting", (event) => {
        if (event.payload.connection_id === sshId) {
          setState("reconnecting");
          setAttempt(event.payload.attempt);
          setMaxAttempts(event.payload.max_attempts);
        }
      }),
      listen<number>("ssh-reconnected", (event) => {
        // Stay on "reconnecting" — the backdrop holds while ACP sessions restore, and
        // acp-sessions-restored is what finally clears it.
        if (event.payload === sshId) setState("reconnecting");
      }),
      listen<number>("acp-sessions-restored", (event) => {
        if (event.payload === sshId) {
          setState("connected");
          setAttempt(0);
        }
      }),
      listen<number>("ssh-connection-failed", (event) => {
        if (event.payload === sshId) setState("failed");
      }),
    ]).catch(console.error);

    return () => {
      unlisteners.then((fns) => {
        if (fns) for (const fn of fns) fn();
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionType, connectionId]);

  return { state, attempt, maxAttempts, dismiss };
}
