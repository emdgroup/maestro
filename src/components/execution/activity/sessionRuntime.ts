import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { drainAcpReplay } from "@/services/execution.service";
import { loadSavedCanvases, saveCanvasSurface } from "@/services/canvas.service";
import { useSessionActivityStore } from "@/store/sessionActivityStore";
import { activityReducer, type ActivityAction } from "./activityReducer";
import { INITIAL_ACTIVITY_STATE } from "./types";
import type {
  ActivityState,
  AvailableCommand,
  CanvasSurface,
  ConfigOption,
  SessionUpdatePayload,
  UsageState,
} from "./types";
import type { PendingCanvasAwait } from "./canvas/await-matching";

/*
  A live session's state, held outside React.

  The panel that shows a session is unmounted whenever the window leaves its project, for Home or
  for another project, while the session itself keeps running. State owned by the panel went with
  it: the transcript, and worse, a permission request that arrived meanwhile, leaving the agent
  blocked on a prompt nobody could see. The replay buffer cannot cover for it either, since it is
  drained once, on first mount. So the listeners and everything they build live here, one runtime
  per session, and the panel only subscribes.

  A runtime is dropped once its session has ended and no panel is watching it.
*/

export type AcpPromptCapabilities = {
  embedded_context: boolean;
  image: boolean;
  audio: boolean;
};

export type PendingPermission = { requestId: string; payload: Record<string, unknown> };
export type PendingElicitation = {
  requestId: string;
  message: string;
  payload: Record<string, unknown>;
};

export type SessionLifecycle = {
  configOptions: ConfigOption[];
  configValues: Record<string, string>;
  usageState: UsageState | null;
  availableCommands: AvailableCommand[];
  promptCapabilities: AcpPromptCapabilities | null;
  pendingPermission: PendingPermission | null;
  pendingElicitation: PendingElicitation | null;
  /**
   * Every `canvas_await` the agent is blocked on, oldest first. More than one can be open, and
   * an entry with a `null` surfaceId is answerable from whichever canvas the user acts on.
   */
  pendingCanvasAwaits: PendingCanvasAwait[];
};

export const INITIAL_LIFECYCLE: SessionLifecycle = {
  configOptions: [],
  configValues: {},
  usageState: null,
  availableCommands: [],
  promptCapabilities: null,
  pendingPermission: null,
  pendingElicitation: null,
  pendingCanvasAwaits: [],
};

/** Callbacks into the panel showing the session, present only while one is mounted. */
export type SessionHandlers = {
  onUsageChange?: (usage: UsageState | null) => void;
  /**
   * Called with the ids of surfaces restored from disk. A restored canvas has live controls and
   * nothing listening — the agent is idle and cannot open a `canvas_await` outside a turn — so the
   * panel answers this by prompting it once.
   */
  onCanvasesRestored?: (surfaceIds: string[]) => void;
};

type Runtime = {
  activity: ActivityState;
  lifecycle: SessionLifecycle;
  subscribers: Set<() => void>;
  handlers: SessionHandlers;
  pending: Array<{ action: ActivityAction; raw?: Record<string, unknown> }>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Surfaces already written to disk, by identity. */
  savedCanvases: Map<string, CanvasSurface>;
  /** The canvas map last checked for unsaved surfaces, so an unchanged one is not walked again. */
  checkedCanvasMap: Map<string, CanvasSurface> | null;
  unlisten: Promise<UnlistenFn[] | void>;
};

const runtimes = new Map<string, Runtime>();

/**
 * Sessions already asked to listen to their canvases. Outlives the runtime, so that a session
 * whose runtime was dropped and rebuilt is not asked twice. Cleared when a session ends, so
 * reopening one legitimately asks again.
 */
const canvasTriggered = new Set<string>();

function notify(rt: Runtime) {
  for (const fn of rt.subscribers) fn();
}

function setStatus(sessionId: string, status: "idle" | "awaiting_input") {
  useSessionActivityStore.getState().setActivity(sessionId, status, null);
}

function maybeDispose(sessionId: string, rt: Runtime) {
  if (rt.subscribers.size > 0 || !rt.activity.sessionEnded || runtimes.get(sessionId) !== rt) {
    return;
  }
  runtimes.delete(sessionId);
  if (rt.flushTimer != null) clearTimeout(rt.flushTimer);
  rt.pending = [];
  void rt.unlisten.then((fns) => {
    if (fns) for (const fn of fns) fn();
  });
}

/*
  Canvases are written to disk while the agent is idle, so a restarted app gets them back.

  Fences used to make this free: they were part of the transcript, so a replayed session rebuilt
  every surface from it. Tool calls are not — nothing replays them — so the surface only exists in
  the reducer until it is saved.

  The trigger is the turn ending rather than the surface changing, because the write goes over the
  session's connection: `canvas_update` merges in place, and a dashboard filling in from tool calls
  revises the same surface many times, which on an SSH session is a round trip each. The cost is
  that the app being killed mid-turn loses whatever that turn drew.
*/
function persistCanvases(sessionId: string, rt: Runtime) {
  const { canvasMap, isTurnActive, sessionEnded } = rt.activity;
  if ((isTurnActive && !sessionEnded) || canvasMap === rt.checkedCanvasMap) return;
  rt.checkedCanvasMap = canvasMap;
  for (const [surfaceId, surface] of canvasMap) {
    if (rt.savedCanvases.get(surfaceId) === surface) continue;
    rt.savedCanvases.set(surfaceId, surface);
    saveCanvasSurface(sessionId, surface).catch((e) => {
      console.warn(`[canvas] could not save ${surfaceId}`, e);
    });
  }
}

function applyActivity(sessionId: string, rt: Runtime, action: ActivityAction) {
  rt.activity = activityReducer(rt.activity, action);
  persistCanvases(sessionId, rt);
}

/** The usage, command and config parts of a session update, which the reducer does not track. */
function applySessionUpdate(rt: Runtime, raw: Record<string, unknown>) {
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
  const l = rt.lifecycle;
  if (p.sessionUpdate === "usage_update") {
    if (typeof p.used === "number" && typeof p.size === "number") {
      const usageState: UsageState = {
        used: p.used,
        size: p.size,
        cost: p.cost ?? l.usageState?.cost ?? null,
      };
      rt.lifecycle = { ...l, usageState };
      rt.handlers.onUsageChange?.(usageState);
    }
  } else if (p.sessionUpdate === "available_commands_update") {
    if (Array.isArray(p.availableCommands)) {
      rt.lifecycle = { ...l, availableCommands: p.availableCommands };
    }
  } else if (p.sessionUpdate === "config_option_update") {
    if (Array.isArray(p.configOptions)) {
      rt.lifecycle = {
        ...l,
        configOptions: p.configOptions,
        configValues: valuesOf(p.configOptions),
      };
    }
  } else if (p.sessionUpdate === "current_model_update") {
    const modelId = p.modelId ?? p.currentModelId;
    if (modelId) rt.lifecycle = { ...l, configValues: { ...l.configValues, model: modelId } };
  } else if (p.sessionUpdate === "current_mode_update") {
    const modeId = p.modeId ?? p.currentModeId;
    if (modeId) rt.lifecycle = { ...l, configValues: { ...l.configValues, mode: modeId } };
  }
}

function valuesOf(options: ConfigOption[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const opt of options) {
    if (opt.currentValue) values[opt.id] = opt.currentValue;
  }
  return values;
}

/** Adds a model or mode option announced on its own, unless the catalog already carries one. */
function withOption(
  l: SessionLifecycle,
  id: "model" | "mode",
  name: string,
  current: string,
  options: Array<{ name: string; value: string }>,
): SessionLifecycle {
  const configOptions = l.configOptions.some((o) => o.id === id)
    ? l.configOptions
    : [...l.configOptions, { id, name, category: id, currentValue: current, options }];
  return { ...l, configOptions, configValues: { ...l.configValues, [id]: current } };
}

function create(sessionId: string): Runtime {
  const rt: Runtime = {
    activity: INITIAL_ACTIVITY_STATE,
    lifecycle: INITIAL_LIFECYCLE,
    subscribers: new Set(),
    handlers: {},
    pending: [],
    flushTimer: null,
    savedCanvases: new Map(),
    checkedCanvasMap: null,
    unlisten: Promise.resolve(),
  };

  // Stream events can arrive at token rate; applying each one individually forces a render per
  // event and saturates the renderer thread (frozen spinners, laggy typing). Buffer them and flush
  // at most every 50ms, as one notification.
  const enqueue = (action: ActivityAction, raw?: Record<string, unknown>) => {
    rt.pending.push({ action, raw });
    if (rt.flushTimer != null) return;
    rt.flushTimer = setTimeout(() => {
      rt.flushTimer = null;
      const batch = rt.pending;
      rt.pending = [];
      for (const { action: a, raw: r } of batch) {
        applyActivity(sessionId, rt, a);
        if (r) applySessionUpdate(rt, r);
      }
      notify(rt);
      maybeDispose(sessionId, rt);
    }, 50);
  };

  const updateLifecycle = (fn: (l: SessionLifecycle) => SessionLifecycle) => {
    rt.lifecycle = fn(rt.lifecycle);
    notify(rt);
  };

  const tryRestoreCanvases = () => {
    loadSavedCanvases(sessionId)
      .then((surfaces) => {
        if (surfaces.length === 0) return;
        // They came off disk, so they are already written. Without this the save would copy every
        // restored surface straight back, which on a remote session is a round trip each.
        for (const surface of surfaces) rt.savedCanvases.set(surface.surfaceId, surface);
        applyActivity(sessionId, rt, { type: "restore_canvases", surfaces });
        notify(rt);
        if (canvasTriggered.has(sessionId)) return;
        canvasTriggered.add(sessionId);
        rt.handlers.onCanvasesRestored?.(surfaces.map((surface) => surface.surfaceId));
      })
      .catch(console.error);
  };

  rt.unlisten = Promise.all([
    listen<unknown>(`acp://session-update/${sessionId}`, (event) => {
      const raw = event.payload as Record<string, unknown>;
      enqueue({ type: "event", payload: raw as unknown as SessionUpdatePayload, raw }, raw);
    }),
    listen<null>(`acp://session-ended/${sessionId}`, () => {
      // Reopening this session will restore its canvases into an agent that is listening to
      // nothing again, so the ask is owed a second time.
      canvasTriggered.delete(sessionId);
      enqueue({ type: "session_ended" });
    }),
    listen<string>(`acp://turn-ended/${sessionId}`, (e) => {
      const stopReason = e.payload;
      if (stopReason === "error" || stopReason === "auth_required") {
        enqueue({
          type: "append_error",
          stopReason,
          message:
            stopReason === "auth_required"
              ? "Authentication required. Log in to continue."
              : "Agent encountered an error and could not respond.",
        });
      }
      enqueue({ type: "turn_ended" });
      setStatus(sessionId, "idle");
    }),
    listen<null>(`acp://replay-drained/${sessionId}`, () => {
      enqueue({ type: "turn_ended" });
      enqueue({ type: "set_initialized" });
      tryRestoreCanvases();
      setStatus(sessionId, "idle");
    }),
    listen<null>(`acp://spawn-ok/${sessionId}`, () => {
      enqueue({ type: "turn_ended" });
      enqueue({ type: "set_initialized" });
      tryRestoreCanvases();
    }),
    listen<string>(`acp://session-error/${sessionId}`, (event) => {
      // A failed restore is not "the agent failed to start", and reopening a project whose
      // worktrees have been pruned produces one per stale session — which is why it gets no
      // toast. But it still ends the session, and that takes the compose bar with it, so
      // saying nothing left a session the user could read and not type into with no clue
      // why. It goes in the transcript they are already looking at instead.
      if (event.payload.includes("session/load failed")) {
        enqueue({
          type: "append_error",
          stopReason: "error",
          message: `This session could not be restored and has been closed. ${event.payload}`,
        });
      } else {
        toast.error(`Agent failed to start: ${event.payload}`);
      }
      enqueue({ type: "session_ended" });
      enqueue({ type: "set_initialized" });
    }),
    listen<{ terminal_id: string; output: string }>(
      `acp://terminal-output/${sessionId}`,
      (event) => {
        applyActivity(sessionId, rt, {
          type: "terminal_output",
          terminalId: event.payload.terminal_id,
          output: event.payload.output,
        });
        notify(rt);
      },
    ),
    listen<{ request_id: string; payload: Record<string, unknown> }>(
      `acp://permission-request/${sessionId}`,
      (event) => {
        updateLifecycle((l) => ({
          ...l,
          pendingPermission: {
            requestId: event.payload.request_id,
            payload: event.payload.payload,
          },
        }));
        setStatus(sessionId, "awaiting_input");
      },
    ),
    listen<{ request_id: string; message: string; payload: Record<string, unknown> }>(
      `acp://elicitation-request/${sessionId}`,
      (event) => {
        updateLifecycle((l) => ({
          ...l,
          pendingElicitation: {
            requestId: event.payload.request_id,
            message: event.payload.message,
            payload: event.payload.payload,
          },
        }));
        setStatus(sessionId, "awaiting_input");
      },
    ),
    listen<{ request_id: string; surface_id: string | null }>(
      `acp://canvas-await/${sessionId}`,
      (event) => {
        updateLifecycle((l) => ({
          ...l,
          pendingCanvasAwaits: [
            ...l.pendingCanvasAwaits.filter(
              (entry) => entry.requestId !== event.payload.request_id,
            ),
            { requestId: event.payload.request_id, surfaceId: event.payload.surface_id ?? null },
          ],
        }));
      },
    ),
    // The wait can end without an answer — it times out on its own schedule — so the end is its
    // own event rather than something the answer path clears. Removed by request id, not by
    // surface: waits on other surfaces are still open and must survive this one ending.
    listen<{ request_id: string }>(`acp://canvas-await-ended/${sessionId}`, (event) => {
      updateLifecycle((l) => ({
        ...l,
        pendingCanvasAwaits: l.pendingCanvasAwaits.filter(
          (entry) => entry.requestId !== event.payload.request_id,
        ),
      }));
    }),
    listen<AcpPromptCapabilities>(`acp://session-capabilities/${sessionId}`, (event) => {
      updateLifecycle((l) => ({ ...l, promptCapabilities: event.payload }));
    }),
    listen<{
      current_model_id: string;
      available_models: Array<{ model_id: string; name: string }>;
    }>(`acp://session-models/${sessionId}`, (event) => {
      const { current_model_id, available_models } = event.payload;
      updateLifecycle((l) =>
        withOption(
          l,
          "model",
          "Model",
          current_model_id,
          available_models.map((m) => ({ name: m.name, value: m.model_id })),
        ),
      );
    }),
    listen<{
      current_mode_id: string;
      available_modes: Array<{ mode_id: string; name: string }>;
    }>(`acp://session-modes/${sessionId}`, (event) => {
      const { current_mode_id, available_modes } = event.payload;
      updateLifecycle((l) =>
        withOption(
          l,
          "mode",
          "Permission mode",
          current_mode_id,
          available_modes.map((m) => ({ name: m.name, value: m.mode_id })),
        ),
      );
    }),
    listen<string>(`acp://model-changed/${sessionId}`, (event) => {
      updateLifecycle((l) => ({ ...l, configValues: { ...l.configValues, model: event.payload } }));
    }),
    listen<string>(`acp://mode-changed/${sessionId}`, (event) => {
      updateLifecycle((l) => ({ ...l, configValues: { ...l.configValues, mode: event.payload } }));
    }),
    listen<{ config_id: string; value: string; configOptions: ConfigOption[] }>(
      `acp://config-state-updated/${sessionId}`,
      (event) => {
        const { configOptions, config_id, value } = event.payload;
        updateLifecycle((l) =>
          Array.isArray(configOptions) && configOptions.length > 0
            ? { ...l, configOptions, configValues: valuesOf(configOptions) }
            : { ...l, configValues: { ...l.configValues, [config_id]: value } },
        );
      },
    ),
  ])
    .then((fns) => {
      // Only once every listener is in place, or the start of the replay is lost.
      drainAcpReplay(sessionId).catch(console.error);
      return fns;
    })
    .catch(console.error);

  return rt;
}

function ensure(sessionId: string): Runtime {
  let rt = runtimes.get(sessionId);
  if (!rt) {
    rt = create(sessionId);
    runtimes.set(sessionId, rt);
  }
  return rt;
}

export function subscribeSession(sessionId: string, fn: () => void): () => void {
  const rt = ensure(sessionId);
  rt.subscribers.add(fn);
  return () => {
    rt.subscribers.delete(fn);
    // Deferred, so a remount that subscribes again straight away does not lose the runtime.
    setTimeout(() => maybeDispose(sessionId, rt), 0);
  };
}

export function getActivity(sessionId: string): ActivityState {
  return runtimes.get(sessionId)?.activity ?? INITIAL_ACTIVITY_STATE;
}

export function getLifecycle(sessionId: string): SessionLifecycle {
  return runtimes.get(sessionId)?.lifecycle ?? INITIAL_LIFECYCLE;
}

export function dispatchActivity(sessionId: string, action: ActivityAction) {
  const rt = runtimes.get(sessionId);
  if (!rt) return;
  applyActivity(sessionId, rt, action);
  notify(rt);
}

export function updateLifecycle(sessionId: string, fn: (l: SessionLifecycle) => SessionLifecycle) {
  const rt = runtimes.get(sessionId);
  if (!rt) return;
  rt.lifecycle = fn(rt.lifecycle);
  notify(rt);
}

/**
 * Points one of the session's callbacks at the mounted panel; the returned function detaches it.
 * Call after subscribing, so the runtime exists.
 */
export function setSessionHandler<K extends keyof SessionHandlers>(
  sessionId: string,
  key: K,
  fn: NonNullable<SessionHandlers[K]>,
): () => void {
  const rt = runtimes.get(sessionId);
  if (!rt) return () => {};
  rt.handlers[key] = fn;
  return () => {
    if (rt.handlers[key] === fn) rt.handlers[key] = undefined;
  };
}
