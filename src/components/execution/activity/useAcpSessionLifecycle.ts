import React, { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSessionActivityActions } from "@/store/sessionActivityStore";
import type { AvailableCommand, UsageState, ConfigOption } from "./types";
import type { PendingCanvasAwait } from "./canvas/await-matching";
export type AcpPromptCapabilities = {
  embedded_context: boolean;
  image: boolean;
  audio: boolean;
};

export type AcpSessionLifecycleResult = {
  configOptions: ConfigOption[];
  configValues: Record<string, string>;
  usageState: UsageState | null;
  availableCommands: AvailableCommand[];
  promptCapabilities: AcpPromptCapabilities | null;
  pendingPermission: { requestId: string; payload: Record<string, unknown> } | null;
  setPendingPermission: React.Dispatch<
    React.SetStateAction<{ requestId: string; payload: Record<string, unknown> } | null>
  >;
  pendingElicitation: {
    requestId: string;
    message: string;
    payload: Record<string, unknown>;
  } | null;
  setPendingElicitation: React.Dispatch<
    React.SetStateAction<{
      requestId: string;
      message: string;
      payload: Record<string, unknown>;
    } | null>
  >;
  /**
   * Every `canvas_await` the agent is blocked on, oldest first. More than one can be open, and
   * an entry with a `null` surfaceId is answerable from whichever canvas the user acts on.
   */
  pendingCanvasAwaits: PendingCanvasAwait[];
};

export function useAcpSessionLifecycle(
  sessionId: string,
  onUsageChangeRef: React.RefObject<((usage: UsageState | null) => void) | undefined>,
  sessionUpdateRef?: React.RefObject<((payload: Record<string, unknown>) => void) | undefined>,
): AcpSessionLifecycleResult {
  const { setActivity: setActivityStatus } = useSessionActivityActions();

  const [configOptions, setConfigOptions] = useState<ConfigOption[]>([]);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [usageState, setUsageState] = useState<UsageState | null>(null);
  const [availableCommands, setAvailableCommands] = useState<AvailableCommand[]>([]);
  const [promptCapabilities, setPromptCapabilities] = useState<AcpPromptCapabilities | null>(null);
  const [pendingPermission, setPendingPermission] = useState<{
    requestId: string;
    payload: Record<string, unknown>;
  } | null>(null);
  const [pendingElicitation, setPendingElicitation] = useState<{
    requestId: string;
    message: string;
    payload: Record<string, unknown>;
  } | null>(null);
  const [pendingCanvasAwaits, setPendingCanvasAwaits] = useState<PendingCanvasAwait[]>([]);

  useEffect(() => {
    const unlisten = Promise.all([
      listen<string>(`acp://turn-ended/${sessionId}`, () => {
        setActivityStatus(sessionId, "idle", null);
      }),
      listen<null>(`acp://replay-drained/${sessionId}`, () => {
        setActivityStatus(sessionId, "idle", null);
      }),
      listen<{ request_id: string; payload: Record<string, unknown> }>(
        `acp://permission-request/${sessionId}`,
        (event) => {
          const permPayload = event.payload.payload;
          setPendingPermission({
            requestId: event.payload.request_id,
            payload: permPayload,
          });
          setActivityStatus(sessionId, "awaiting_input");
        },
      ),
      listen<{
        request_id: string;
        message: string;
        payload: Record<string, unknown>;
      }>(`acp://elicitation-request/${sessionId}`, (event) => {
        setPendingElicitation({
          requestId: event.payload.request_id,
          message: event.payload.message,
          payload: event.payload.payload,
        });
        setActivityStatus(sessionId, "awaiting_input");
      }),
      listen<{ request_id: string; surface_id: string | null }>(
        `acp://canvas-await/${sessionId}`,
        (event) => {
          setPendingCanvasAwaits((prev) => [
            ...prev.filter((entry) => entry.requestId !== event.payload.request_id),
            { requestId: event.payload.request_id, surfaceId: event.payload.surface_id ?? null },
          ]);
        },
      ),
      // The wait can end without an answer — it times out on its own schedule — so the end is
      // its own event rather than something the answer path clears. Removed by request id, not
      // by surface: waits on other surfaces are still open and must survive this one ending.
      listen<{ request_id: string }>(`acp://canvas-await-ended/${sessionId}`, (event) => {
        setPendingCanvasAwaits((prev) =>
          prev.filter((entry) => entry.requestId !== event.payload.request_id),
        );
      }),
      listen<AcpPromptCapabilities>(`acp://session-capabilities/${sessionId}`, (event) => {
        setPromptCapabilities(event.payload);
      }),
      listen<{
        current_model_id: string;
        available_models: Array<{ model_id: string; name: string }>;
      }>(`acp://session-models/${sessionId}`, (event) => {
        const { current_model_id, available_models } = event.payload;
        setConfigOptions((prev) => {
          if (prev.some((o) => o.id === "model")) return prev;
          return [
            ...prev,
            {
              id: "model",
              name: "Model",
              category: "model",
              currentValue: current_model_id,
              options: available_models.map((m) => ({ name: m.name, value: m.model_id })),
            },
          ];
        });
        setConfigValues((prev) => ({ ...prev, model: current_model_id }));
      }),
      listen<{
        current_mode_id: string;
        available_modes: Array<{ mode_id: string; name: string }>;
      }>(`acp://session-modes/${sessionId}`, (event) => {
        const { current_mode_id, available_modes } = event.payload;
        setConfigOptions((prev) => {
          if (prev.some((o) => o.id === "mode")) return prev;
          return [
            ...prev,
            {
              id: "mode",
              name: "Permission mode",
              category: "mode",
              currentValue: current_mode_id,
              options: available_modes.map((m) => ({ name: m.name, value: m.mode_id })),
            },
          ];
        });
        setConfigValues((prev) => ({ ...prev, mode: current_mode_id }));
      }),
      listen<string>(`acp://model-changed/${sessionId}`, (event) => {
        setConfigValues((prev) => ({ ...prev, model: event.payload }));
      }),
      listen<string>(`acp://mode-changed/${sessionId}`, (event) => {
        setConfigValues((prev) => ({ ...prev, mode: event.payload }));
      }),
      listen<{
        config_id: string;
        value: string;
        configOptions: ConfigOption[];
      }>(`acp://config-state-updated/${sessionId}`, (event) => {
        const { configOptions: options, config_id, value } = event.payload;
        if (Array.isArray(options) && options.length > 0) {
          setConfigOptions(options);
          const values: Record<string, string> = {};
          for (const opt of options) {
            if (opt.currentValue) values[opt.id] = opt.currentValue;
          }
          setConfigValues(values);
        } else {
          setConfigValues((prev) => ({ ...prev, [config_id]: value }));
        }
      }),
    ])
      .then((listeners) => listeners)
      .catch(console.error);

    return () => {
      unlisten.then((fns) => {
        if (fns) for (const fn of fns) fn();
      });
    };
  }, [sessionId, setActivityStatus]);

  // Write session-update handler to the shared ref so useAcpActivity (which registers
  // its listener before drain) can forward events here without a race condition.
  //
  // Assigned from an effect, with no dependency list so every render republishes the
  // current closure. `AgentActivityPanel` calls `useAcpActivity` first, so its listener
  // effect does run before this one — but that listener only buffers, and the ref is
  // read from the 50ms flush timer (`useAcpActivity.ts`), never synchronously. By the
  // time the first flush fires this has long since been assigned.
  useEffect(() => {
    if (!sessionUpdateRef) return;
    sessionUpdateRef.current = (raw: Record<string, unknown>) => {
      const p = raw as {
        sessionUpdate?: string;
        used?: number;
        size?: number;
        cost?: { amount: number; currency: string };
        availableCommands?: AvailableCommand[];
        configOptions?: ConfigOption[];
        modelId?: string;
        currentModelId?: string;
        modeId?: string;
        currentModeId?: string;
      };
      if (p.sessionUpdate === "usage_update") {
        if (typeof p.used === "number" && typeof p.size === "number") {
          setUsageState((prev) => {
            const next: UsageState = {
              used: p.used!,
              size: p.size!,
              cost: p.cost ?? prev?.cost ?? null,
            };
            onUsageChangeRef.current?.(next);
            return next;
          });
        }
      } else if (p.sessionUpdate === "available_commands_update") {
        if (Array.isArray(p.availableCommands)) {
          setAvailableCommands(p.availableCommands);
        }
      } else if (p.sessionUpdate === "config_option_update") {
        if (Array.isArray(p.configOptions)) {
          setConfigOptions(p.configOptions);
          const values: Record<string, string> = {};
          for (const opt of p.configOptions) {
            if (opt.currentValue) values[opt.id] = opt.currentValue;
          }
          setConfigValues(values);
        }
      } else if (p.sessionUpdate === "current_model_update") {
        const modelId = p.modelId ?? p.currentModelId;
        if (modelId) {
          setConfigValues((prev) => ({ ...prev, model: modelId }));
        }
      } else if (p.sessionUpdate === "current_mode_update") {
        const modeId = p.modeId ?? p.currentModeId;
        if (modeId) {
          setConfigValues((prev) => ({ ...prev, mode: modeId }));
        }
      }
    };
  });

  return {
    configOptions,
    configValues,
    usageState,
    availableCommands,
    promptCapabilities,
    pendingPermission,
    setPendingPermission,
    pendingElicitation,
    setPendingElicitation,
    pendingCanvasAwaits,
  };
}
