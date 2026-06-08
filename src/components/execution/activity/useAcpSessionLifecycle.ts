import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSessionActivityActions } from "@/store/sessionActivityStore";
import { useAgentCacheQuery } from "@/services/execution.service";
import type { AvailableCommand, UsageState, ConfigOption } from "./types";
import type { AcpPromptCapabilities, ConnectionKey } from "@/types/bindings";

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
};

export function useAcpSessionLifecycle(
  sessionKey: number,
  agentId: string | null,
  connection: ConnectionKey,
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

  // Seed configOptions catalog from agent cache (available before any session events arrive)
  const { data: agentCache } = useAgentCacheQuery(agentId, connection);
  useEffect(() => {
    if (!agentCache) return;
    setConfigOptions((prev) => {
      if (prev.length > 0) return prev;
      return agentCache.config_options.map((o) => ({
        id: o.id,
        name: o.name,
        category: o.category ?? undefined,
        currentValue: o.default_value ?? o.options[0]?.value ?? "",
        options: o.options.map((v) => ({
          name: v.name,
          value: v.value,
          description: v.description ?? undefined,
        })),
      }));
    });
    setConfigValues((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const seeded: Record<string, string> = {};
      for (const o of agentCache.config_options) {
        if (o.default_value != null) seeded[o.id] = o.default_value;
      }
      return Object.keys(seeded).length > 0 ? seeded : prev;
    });
    setAvailableCommands((prev) => {
      if (prev.length > 0) return prev;
      return agentCache.available_commands.map((c) => ({
        name: c.name,
        description: c.description,
      }));
    });
    if (agentCache.prompt_capabilities) {
      setPromptCapabilities(
        (prev) => prev ?? (agentCache.prompt_capabilities as AcpPromptCapabilities),
      );
    }
  }, [agentCache]);

  useEffect(() => {
    const unlisten = listen<string>(`acp://turn-ended/${sessionKey}`, () => {
      setActivityStatus(sessionKey, "idle", null);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionKey, setActivityStatus]);

  useEffect(() => {
    const unlisten = listen<{ request_id: string; payload: Record<string, unknown> }>(
      `acp://permission-request/${sessionKey}`,
      (event) => {
        const permPayload = event.payload.payload;
        setPendingPermission({
          requestId: event.payload.request_id,
          payload: permPayload,
        });
        setActivityStatus(sessionKey, "awaiting_input");
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionKey, setActivityStatus]);

  useEffect(() => {
    const unlisten = listen<{
      request_id: string;
      message: string;
      payload: Record<string, unknown>;
    }>(`acp://elicitation-request/${sessionKey}`, (event) => {
      setPendingElicitation({
        requestId: event.payload.request_id,
        message: event.payload.message,
        payload: event.payload.payload,
      });
      setActivityStatus(sessionKey, "awaiting_input");
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionKey, setActivityStatus]);

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
      if (cancelled) {
        unlistenFn();
        return;
      }
      unlisten = unlistenFn;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionKey]);

  // session-models: legacy fallback for agents that don't send config_option_update
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
      });
      if (cancelled) {
        unlistenFn();
        return;
      }
      unlisten = unlistenFn;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionKey]);

  // model-changed: update current value regardless of how options arrived
  useEffect(() => {
    const unlisten = listen<string>(`acp://model-changed/${sessionKey}`, (event) => {
      setConfigValues((prev) => ({ ...prev, model: event.payload }));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionKey]);

  // session-modes: legacy fallback for agents that don't send config_option_update
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
      });
      if (cancelled) {
        unlistenFn();
        return;
      }
      unlisten = unlistenFn;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionKey]);

  // mode-changed: update current value regardless of how options arrived
  useEffect(() => {
    const unlisten = listen<string>(`acp://mode-changed/${sessionKey}`, (event) => {
      setConfigValues((prev) => ({ ...prev, mode: event.payload }));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionKey]);

  useEffect(() => {
    const unlisten = listen<{
      config_id: string;
      value: string;
      configOptions: ConfigOption[];
    }>(`acp://config-state-updated/${sessionKey}`, (event) => {
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
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionKey]);

  // Write session-update handler to the shared ref so useAcpActivity (which registers
  // its listener before drain) can forward events here without a race condition.
  if (sessionUpdateRef) {
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
  }

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
  };
}
