import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export type ConnectionHealthState = "connected" | "lost" | "reconnecting" | "failed";

interface ReconnectingPayload {
  connection_id: number;
  attempt: number;
  max_attempts: number;
}

interface ConnectionHealth {
  state: ConnectionHealthState;
  attempt: number;
  maxAttempts: number;
  dismiss: () => void;
}

/**
 * Hook that subscribes to Tauri SSH connection health events.
 *
 * Listens for:
 * - `ssh-connection-lost` — sets state to "lost"
 * - `ssh-reconnecting` — sets state to "reconnecting" with attempt info
 * - `ssh-reconnected` — sets state back to "connected"
 * - `ssh-connection-failed` — sets state to "failed" (all retries exhausted)
 *
 * Only active when connectionId is non-null (SSH projects).
 * Returns { state, attempt, maxAttempts, dismiss }.
 */
export function useConnectionHealth(connectionId: number | null): ConnectionHealth {
  const [state, setState] = useState<ConnectionHealthState>("connected");
  const [attempt, setAttempt] = useState(0);
  const [maxAttempts, setMaxAttempts] = useState(5);

  const dismiss = () => {
    setState("connected");
    setAttempt(0);
  };

  useEffect(() => {
    if (connectionId == null) {
      setState("connected");
      return;
    }

    const unlisteners = Promise.all([
      listen<number>("ssh-connection-lost", (event) => {
        if (event.payload === connectionId) {
          setState("lost");
        }
      }),
      listen<ReconnectingPayload>("ssh-reconnecting", (event) => {
        if (event.payload.connection_id === connectionId) {
          setState("reconnecting");
          setAttempt(event.payload.attempt);
          setMaxAttempts(event.payload.max_attempts);
        }
      }),
      listen<number>("ssh-reconnected", (event) => {
        if (event.payload === connectionId) {
          // Keep "reconnecting" state — backdrop stays up while ACP sessions restore.
          // acp-sessions-restored will flip us to "connected".
          setState("reconnecting");
        }
      }),
      listen<number>("acp-sessions-restored", (event) => {
        if (event.payload === connectionId) {
          setState("connected");
          setAttempt(0);
        }
      }),
      listen<number>("ssh-connection-failed", (event) => {
        if (event.payload === connectionId) {
          setState("failed");
        }
      }),
    ]);

    return () => {
      unlisteners.then(([u1, u2, u3, u4, u5]) => {
        u1();
        u2();
        u3();
        u4();
        u5();
      });
    };
  }, [connectionId]);

  return { state, attempt, maxAttempts, dismiss };
}
