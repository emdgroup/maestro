import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/tauri-utils";
import { useSessionActivityActions } from "@/store/sessionActivityStore";
import type { AvailableCommand, UsageState } from "./types";
import type { AcpPromptCapabilities } from "@/types/bindings";

export type ModelOption = { id: string; label: string };
export type ModeOption = { id: string; label: string };

export type AcpSessionLifecycleResult = {
  models: ModelOption[];
  modelId: string;
  modelsLoaded: boolean;
  modes: ModeOption[];
  modeId: string;
  usageState: UsageState | null;
  availableCommands: AvailableCommand[];
  promptCapabilities: AcpPromptCapabilities | null;
  pendingPermission: { requestId: string; payload: Record<string, unknown> } | null;
  setPendingPermission: React.Dispatch<
    React.SetStateAction<{ requestId: string; payload: Record<string, unknown> } | null>
  >;
  pendingElicitation: { requestId: string; message: string; payload: Record<string, unknown> } | null;
  setPendingElicitation: React.Dispatch<
    React.SetStateAction<{ requestId: string; message: string; payload: Record<string, unknown> } | null>
  >;
};

export function useAcpSessionLifecycle(
  sessionKey: number,
  onUsageChangeRef: React.MutableRefObject<((usage: UsageState | null) => void) | undefined>,
): AcpSessionLifecycleResult {
  const { setStatus: setActivityStatus } = useSessionActivityActions();

  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState<string>("");
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modes, setModes] = useState<ModeOption[]>([]);
  const [modeId, setModeId] = useState<string>("");
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

  // turn-ended: clear processing and set status idle
  useEffect(() => {
    const unlisten = listen<string>(`acp://turn-ended/${sessionKey}`, () => {
      setActivityStatus(sessionKey, "idle");
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionKey, setActivityStatus]);

  // permission-request
  useEffect(() => {
    const unlisten = listen<{ request_id: string; payload: Record<string, unknown> }>(
      `acp://permission-request/${sessionKey}`,
      (event) => {
        setPendingPermission({
          requestId: event.payload.request_id,
          payload: event.payload.payload,
        });
        setActivityStatus(sessionKey, "awaiting_input");
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionKey, setActivityStatus]);

  // elicitation-request
  useEffect(() => {
    const unlisten = listen<{ request_id: string; message: string; payload: Record<string, unknown> }>(
      `acp://elicitation-request/${sessionKey}`,
      (event) => {
        setPendingElicitation({
          requestId: event.payload.request_id,
          message: event.payload.message,
          payload: event.payload.payload,
        });
        setActivityStatus(sessionKey, "awaiting_input");
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionKey, setActivityStatus]);

  // capabilities: listen first, then fetch to close the race window
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const unlistenFn = await listen<AcpPromptCapabilities>(
        `acp://session-capabilities/${sessionKey}`,
        (event) => {
          if (!cancelled) setPromptCapabilities(event.payload);
        },
      );
      if (cancelled) { unlistenFn(); return; }
      unlisten = unlistenFn;
      const caps = await api.getAcpCapabilities(sessionKey);
      if (!cancelled && caps) setPromptCapabilities(caps);
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionKey]);

  // models: listen first, then fetch to close the race window
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const unlistenFn = await listen<{
        current_model_id: string;
        available_models: Array<{ model_id: string; name: string }>;
      }>(`acp://session-models/${sessionKey}`, (event) => {
        if (cancelled) return;
        const { current_model_id, available_models } = event.payload;
        setModels(available_models.map((m) => ({ id: m.model_id, label: m.name })));
        setModelId(current_model_id);
        setModelsLoaded(true);
      });
      if (cancelled) { unlistenFn(); return; }
      unlisten = unlistenFn;
      const modelState = await api.getAcpModels(sessionKey);
      if (!cancelled && modelState) {
        setModels(modelState.available_models.map((m) => ({ id: m.model_id, label: m.name })));
        setModelId(modelState.current_model_id);
        setModelsLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionKey]);

  // model-changed event
  useEffect(() => {
    const unlisten = listen<string>(`acp://model-changed/${sessionKey}`, (event) => {
      setModelId(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionKey]);

  // modes: listen first, then fetch to close the race window
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const unlistenFn = await listen<{
        current_mode_id: string;
        available_modes: Array<{ mode_id: string; name: string }>;
      }>(`acp://session-modes/${sessionKey}`, (event) => {
        if (cancelled) return;
        const { current_mode_id, available_modes } = event.payload;
        setModes(available_modes.map((m) => ({ id: m.mode_id, label: m.name })));
        setModeId(current_mode_id);
      });
      if (cancelled) { unlistenFn(); return; }
      unlisten = unlistenFn;
      const modeState = await api.getAcpModes(sessionKey);
      if (!cancelled && modeState) {
        setModes(modeState.available_modes.map((m) => ({ id: m.mode_id, label: m.name })));
        setModeId(modeState.current_mode_id);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionKey]);

  // mode-changed event
  useEffect(() => {
    const unlisten = listen<string>(`acp://mode-changed/${sessionKey}`, (event) => {
      setModeId(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionKey]);

  // session-update event (usage + available commands)
  useEffect(() => {
    type SessionUpdatePayloadRaw = {
      sessionUpdate?: string;
      used?: number;
      size?: number;
      cost?: { amount: number; currency: string };
      availableCommands?: AvailableCommand[];
    };
    const unlisten = listen<SessionUpdatePayloadRaw>(
      `acp://session-update/${sessionKey}`,
      (event) => {
        const p = event.payload;
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
        }
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionKey, onUsageChangeRef]);

  // 3s safety valve: unblock UI if session fails to deliver models (crash, etc.)
  useEffect(() => {
    if (modelsLoaded) return;
    const timer = setTimeout(() => setModelsLoaded(true), 3000);
    return () => clearTimeout(timer);
  }, [modelsLoaded]);

  return {
    models,
    modelId,
    modelsLoaded,
    modes,
    modeId,
    usageState,
    availableCommands,
    promptCapabilities,
    pendingPermission,
    setPendingPermission,
    pendingElicitation,
    setPendingElicitation,
  };
}
