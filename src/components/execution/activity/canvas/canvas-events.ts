import { createContext } from "react";

export type CanvasEventKind = "click" | "change" | "submit";

export interface CanvasEvent {
  /** Which canvas the user acted on — they can page between all of them. */
  surfaceId: string;
  /** The `id` attribute of the element in the agent's own HTML. */
  componentId: string;
  kind: CanvasEventKind;
  value?: unknown;
  /** Every field on that surface, so a multi-field form is one round trip for the agent. */
  values: Record<string, unknown>;
}

export interface CanvasEventSink {
  /** Note a field's current value without answering the agent — see `CanvasEvent.values`. */
  record: (componentId: string, value: unknown) => void;
  /** Answers a `canvas_await` if one covers this surface, and otherwise starts a turn. */
  emit: (componentId: string, kind: CanvasEventKind, value?: unknown) => void;
}

/**
 * Present wherever a surface is rendered with somewhere to send events. Absent in the transcript
 * card, whose controls render exactly as they did before they could be wired up.
 */
export const CanvasEventContext = createContext<CanvasEventSink | null>(null);
