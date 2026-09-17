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
 * The same event written as a prompt, for when no `canvas_await` is open to receive it.
 *
 * Says what the tool result would have said, plus the one thing the agent has to be told rather
 * than infer: that it is now back in a turn and can call `canvas_await` to stay in the exchange
 * instead of answering this one event and stopping.
 */
export function describeCanvasEvent(event: CanvasEvent): string {
  const lines = [
    `The user interacted with canvas surface \`${event.surfaceId}\`.`,
    "",
    `- element: \`${event.componentId}\``,
    `- kind: ${event.kind}`,
  ];
  if (event.value !== undefined) lines.push(`- value: ${JSON.stringify(event.value)}`);
  if (Object.keys(event.values).length > 0) {
    lines.push(`- fields: ${JSON.stringify(event.values)}`);
  }
  lines.push(
    "",
    "Act on it as you would on a `canvas_await` result — update the surface with `canvas_update`" +
      " or `canvas_data` — then call `canvas_await` on that surface to keep receiving events" +
      " without the user having to start a turn each time.",
  );
  return lines.join("\n");
}

/**
 * Present wherever a surface is rendered with somewhere to send events. Absent in the transcript
 * card, whose controls render exactly as they did before they could be wired up.
 */
export const CanvasEventContext = createContext<CanvasEventSink | null>(null);
