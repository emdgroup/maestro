import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { sendNotification } from "@tauri-apps/plugin-notification";
import type { ActiveSessionInfo, AppSettings } from "@/types/bindings";
import { extractTitle } from "@/components/execution/activity/permission-prompt-utils";
import {
  agentLabel,
  notificationBody,
  signalForElicitation,
  signalForPermission,
  signalForStopReason,
  type NotifyKind,
  type SessionSignal,
} from "@/lib/session-notification";

function toastEnabled(settings: AppSettings | undefined, kind: NotifyKind): boolean {
  if (!settings) return false;
  if (kind === "done") return settings.notify_on_done ?? false;
  if (kind === "attention") return settings.notify_on_input_needed ?? false;
  return settings.notify_on_failure ?? false;
}

/**
 * Flashes the window and, when the user opted in, raises an OS toast whenever an agent finishes,
 * blocks on the user, or fails.
 *
 * Mounted once next to the session list rather than inside `AgentActivityPanel`, so it does not
 * depend on which session is selected. Both signals are suppressed while the window has focus —
 * `requestUserAttention` already ignores a focused window, but `sendNotification` does not.
 */
export function useSessionNotifications(
  sessions: ActiveSessionInfo[],
  settings: AppSettings | undefined,
) {
  // Mirrored from an effect rather than assigned during render — both are read
  // only inside the Tauri event callbacks below, which run long after commit.
  const sessionsRef = useRef(sessions);
  const settingsRef = useRef(settings);
  useEffect(() => {
    sessionsRef.current = sessions;
    settingsRef.current = settings;
  });

  // Windows and macOS drop the request once the window is focused; Linux holds the GTK urgency
  // hint until it is cleared explicitly.
  useEffect(() => {
    const window = getCurrentWindow();
    const unlisten = window.onFocusChanged(({ payload: focused }) => {
      if (focused) void window.requestUserAttention(null);
    });
    return () => void unlisten.then((off) => off());
  }, []);

  const acpKeys = sessions
    .filter((session) => session.execution_mode === "acp")
    .map((session) => session.session_key)
    .sort((a, b) => a - b)
    .join(",");

  useEffect(() => {
    if (!acpKeys) return;
    const window = getCurrentWindow();
    let disposed = false;
    const unlistens: UnlistenFn[] = [];

    async function raise(sessionKey: number, build: (agent: string) => SessionSignal | null) {
      const session = sessionsRef.current.find((s) => s.session_key === sessionKey);
      if (!session) return;
      const signal = build(agentLabel(session));
      if (!signal) return;
      if (await window.isFocused()) return;

      void window.requestUserAttention(
        signal.kind === "done" ? UserAttentionType.Informational : UserAttentionType.Critical,
      );

      if (!toastEnabled(settingsRef.current, signal.kind)) return;
      sendNotification({ title: signal.title, body: notificationBody(session, signal.detail) });
    }

    const keys = acpKeys.split(",").map(Number);
    void Promise.all(
      keys.flatMap((key) => [
        listen<string>(`acp://turn-ended/${key}`, (event) => {
          void raise(key, (agent) => signalForStopReason(event.payload, agent));
        }),
        listen<{ payload: Record<string, unknown> }>(`acp://permission-request/${key}`, (event) => {
          const title = extractTitle(event.payload.payload);
          void raise(key, (agent) => signalForPermission(agent, title === "Action" ? null : title));
        }),
        listen(`acp://elicitation-request/${key}`, () => {
          void raise(key, (agent) => signalForElicitation(agent));
        }),
      ]),
    ).then((offs) => {
      if (disposed) offs.forEach((off) => off());
      else unlistens.push(...offs);
    });

    return () => {
      disposed = true;
      unlistens.forEach((off) => off());
    };
  }, [acpKeys]);
}
