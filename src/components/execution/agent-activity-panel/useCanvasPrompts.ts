import { useCallback, useEffect, useReducer, useRef, type Dispatch, type RefObject } from "react";
import { toast } from "sonner";
import type { JsonValue } from "@/types/bindings";
import { respondHostTool } from "@/services/execution.service";
import { useSessionActivityActions } from "@/store/sessionActivityStore";
import { useCanvasImport } from "@/components/execution/side-panel/useCanvasImport";
import {
  buildCanvasEventPrompt,
  buildCanvasRestoredPrompt,
} from "@/components/execution/activity/canvas/canvas-prompt";
import type { CanvasEvent } from "@/components/execution/activity/canvas/canvas-events";
import {
  awaitForSurface,
  type PendingCanvasAwait,
} from "@/components/execution/activity/canvas/await-matching";
import type { ActivityAction } from "../activity/useAcpActivity";
import type { CanvasSurface } from "../activity/types";

/**
 * Everything a canvas says to the agent: a control's event, answered straight into an open
 * `canvas_await` or sent as a prompt; an imported file's prompt; and the one prompt that asks the
 * agent to re-arm after restored canvases come back. ACP allows one `session/prompt` per turn, so
 * what arrives mid-turn is queued and drained once the agent can take it.
 */
export function useCanvasPrompts({
  sessionId,
  canvasMap,
  sessionEnded,
  isProcessing,
  pendingCanvasAwaits,
  liveDispatch,
  handleSend,
  canvasesRestoredRef,
}: {
  sessionId: string;
  canvasMap: Map<string, CanvasSurface>;
  sessionEnded: boolean;
  isProcessing: boolean;
  pendingCanvasAwaits: PendingCanvasAwait[];
  liveDispatch: Dispatch<ActivityAction>;
  handleSend: (content: string) => Promise<unknown>;
  canvasesRestoredRef: RefObject<((surfaceIds: string[]) => void) | undefined>;
}) {
  const { setActivity } = useSessionActivityActions();

  // A surface outlives the turn that drew it: restoring a session brings its canvases back while
  // the agent is idle, and an idle agent cannot have a `canvas_await` open because it cannot call
  // a tool outside a turn. So a control with no wait behind it sends its event as a prompt, which
  // starts one, after which the agent answers and re-arms, and everything that follows takes the
  // direct path. Without this a restored canvas is a picture of a UI rather than a UI.
  //
  // Both queues below are refs, not state: nothing renders them, and draining state from an
  // effect re-renders for no reason. Queuing bumps `canvasQueueTick` so the drain still runs.
  const queuedCanvasEventsRef = useRef<CanvasEvent[]>([]);
  const [canvasQueueTick, wakeCanvasQueues] = useReducer((n: number) => n + 1, 0);
  const handleCanvasEvent = useCallback(
    (requestId: string | null, event: unknown) => {
      if (requestId) {
        void respondHostTool(sessionId, requestId, event as JsonValue).catch(() => {
          toast.error("Could not send your answer to the agent");
        });
        setActivity(sessionId, "thinking");
        return;
      }
      // Mid-turn there is nowhere to put it: ACP allows one `session/prompt` per turn, and the
      // agent has not armed a wait. Queued rather than dropped: the gap between one
      // `canvas_await` returning and the next one arming is on every turn, and a click lost there
      // leaves the agent acting on a surface it can no longer see.
      if (isProcessing) {
        queuedCanvasEventsRef.current.push(event as CanvasEvent);
        wakeCanvasQueues();
        return;
      }
      void handleSend(buildCanvasEventPrompt([event as CanvasEvent]));
    },
    [sessionId, setActivity, isProcessing, handleSend],
  );

  // Drains one event per pass: answering a wait consumes it, and its `canvas-await-ended` changes
  // `pendingCanvasAwaits`, which runs the effect again for the next event. Only when no wait can
  // take them and the agent has gone idle do the rest travel together as a prompt.
  useEffect(() => {
    const queued = queuedCanvasEventsRef.current;
    const [next, ...rest] = queued;
    if (!next || sessionEnded) return;
    const waiting = awaitForSurface(pendingCanvasAwaits, next.surfaceId);
    if (waiting) {
      queuedCanvasEventsRef.current = rest;
      void respondHostTool(sessionId, waiting.requestId, next as unknown as JsonValue).catch(() =>
        toast.error("Could not send your answer to the agent"),
      );
      setActivity(sessionId, "thinking");
      return;
    }
    if (isProcessing) return;
    queuedCanvasEventsRef.current = [];
    void handleSend(buildCanvasEventPrompt(queued));
  }, [
    canvasQueueTick,
    pendingCanvasAwaits,
    isProcessing,
    sessionEnded,
    sessionId,
    setActivity,
    handleSend,
  ]);

  // An import happens whenever the user says so, which may be mid-turn. Held until the agent is
  // idle, then drained one at a time: sending the first makes it busy again, so the next waits
  // for that turn in its turn.
  const queuedCanvasPromptsRef = useRef<string[]>([]);
  const queueCanvasPrompt = useCallback((text: string) => {
    queuedCanvasPromptsRef.current.push(text);
    wakeCanvasQueues();
  }, []);
  useEffect(() => {
    const [next, ...rest] = queuedCanvasPromptsRef.current;
    if (!next || isProcessing || sessionEnded) return;
    queuedCanvasPromptsRef.current = rest;
    void handleSend(next);
  }, [canvasQueueTick, isProcessing, sessionEnded, handleSend]);

  const canvasImport = useCanvasImport({
    sessionId,
    canvasMap,
    onSurface: (surface) => liveDispatch({ type: "restore_canvases", surfaces: [surface] }),
    onCloseSurface: (surfaceId) => liveDispatch({ type: "close_canvas", surfaceId }),
    onPrompt: queueCanvasPrompt,
  });

  // One prompt however many canvases came back, and only to ask the agent to arm `canvas_await`;
  // after that every click is answered directly and costs nothing. `sessionRuntime` owns the
  // once-per-session part, which cannot live in the panel: it remounts.
  useEffect(() => {
    canvasesRestoredRef.current = (surfaceIds: string[]) => {
      if (surfaceIds.length > 0) void handleSend(buildCanvasRestoredPrompt(surfaceIds));
    };
  }, [canvasesRestoredRef, handleSend]);

  return { handleCanvasEvent, canvasImport };
}
