/**
 * Waking an idle agent for a canvas.
 *
 * ACP has exactly one way to make an agent act: `session/prompt`. A tool call — `canvas_await`
 * included — can only exist inside a turn, so an agent that has finished one is unreachable until
 * something prompts it. That is why a restored surface, whose controls are perfectly alive, has
 * nothing listening behind them.
 *
 * So Maestro prompts, but at most once: the prompt below goes out when saved canvases are
 * restored, and asks the agent to arm `canvas_await` and keep it armed. While a wait is open every
 * interaction is answered directly, and no further prompt is sent. The event prompt is the fallback
 * for when the agent let its wait lapse, and carries however many interactions queued up meanwhile.
 *
 * Both are wrapped in a `<canvas-event>` element so the stream can render them as what they are —
 * a click, not a paragraph the user typed. The wrapper is also the first thing the agent reads,
 * and it costs a line to say what the rest of the text then explains.
 */

import type { CanvasEvent } from "./canvas-events";

const TAG = "canvas-event";

export type CanvasPrompt =
  | { kind: "event"; surfaceId: string; componentId: string; eventKind: string }
  | { kind: "restored"; surfaces: string[] };

function attribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function wrap(attributes: string, body: string): string {
  return `<${TAG} ${attributes}>\n${body}\n</${TAG}>`;
}

/** What to send when a session comes back with canvases on it. One prompt, however many there are. */
export function buildCanvasRestoredPrompt(surfaceIds: readonly string[]): string {
  const named = surfaceIds.map((id) => `\`${id}\``).join(", ");
  return wrap(
    `kind="restored" surface="${attribute(surfaceIds.join(","))}"`,
    [
      `This session restored ${surfaceIds.length} canvas ${
        surfaceIds.length === 1 ? "surface" : "surfaces"
      }: ${named}.`,
      "",
      "Their controls are live, but no `canvas_await` is open, so nothing reaches you. Call" +
        " `canvas_await` now and call it again each time it returns — an open wait is what lets" +
        " the user's clicks reach you directly instead of costing a prompt each. It answers" +
        " within 60 seconds either way, and returns `{timeout:true}` when nothing happened.",
      "",
      "Say nothing about this message. Reply only to what a surface event actually asks for.",
    ].join("\n"),
  );
}

function describe(event: CanvasEvent, prefix: string): string[] {
  const lines = [`${prefix}element: \`${event.componentId}\``, `${prefix}kind: ${event.kind}`];
  if (event.value !== undefined) lines.push(`${prefix}value: ${JSON.stringify(event.value)}`);
  if (Object.keys(event.values).length > 0) {
    lines.push(`${prefix}fields: ${JSON.stringify(event.values)}`);
  }
  return lines;
}

/**
 * The fallback: interactions arrived with no wait open, so they have to travel as a prompt.
 *
 * Takes a list because they queue. An event that lands while the agent is mid-turn cannot be sent
 * — ACP allows one `session/prompt` per turn — so it waits, and by the time the turn ends there
 * may be several. Sending them as one prompt keeps them in order and costs one turn rather than
 * one each.
 */
export function buildCanvasEventPrompt(events: readonly CanvasEvent[]): string {
  const [first] = events;
  if (!first) return "";
  const body =
    events.length === 1
      ? [`The user acted on canvas surface \`${first.surfaceId}\`.`, "", ...describe(first, "- ")]
      : [
          `The user acted on your canvas ${events.length} times while you were busy, oldest first.`,
          "",
          ...events.flatMap((event, i) => [
            `${i + 1}. surface \`${event.surfaceId}\``,
            ...describe(event, "   - "),
          ]),
        ];
  body.push(
    "",
    "Act on it with `canvas_update` or `canvas_data`, then call `canvas_await` on that surface" +
      " and keep re-arming it, so the next interaction reaches you without another prompt.",
  );
  return wrap(
    `kind="${attribute(first.kind)}" surface="${attribute(first.surfaceId)}"` +
      ` element="${attribute(first.componentId)}"` +
      (events.length > 1 ? ` count="${events.length}"` : ""),
    body.join("\n"),
  );
}

/** Null for anything a person typed, which is everything without the wrapper. */
export function parseCanvasPrompt(raw: string): CanvasPrompt | null {
  const open = raw.match(new RegExp(`^\\s*<${TAG}\\s+([^>]*)>`));
  if (!open?.[1]) return null;

  const attributes: Record<string, string> = {};
  for (const [, name, value] of open[1].matchAll(/([a-z]+)="([^"]*)"/g)) {
    attributes[name] = value
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&");
  }

  const surface = attributes.surface ?? "";
  if (attributes.kind === "restored") {
    return { kind: "restored", surfaces: surface.split(",").filter(Boolean) };
  }
  if (!surface) return null;
  return {
    kind: "event",
    surfaceId: surface,
    componentId: attributes.element ?? "",
    eventKind: attributes.kind ?? "click",
  };
}
