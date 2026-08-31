import { api } from "@/lib/tauri-utils";
import { commentAnchor } from "@/components/execution/diff/comment-anchor";
import type { Annotation } from "@/store/annotationStore";
import type { CanvasComponent, CanvasSurface } from "@/components/execution/activity/types";
import type { JsonValue } from "@/types/bindings";

/** Past this the subtree stops being context and starts being the whole prompt. */
const MAX_SUBTREE_CHARS = 2000;
const MAX_SUBTREE_COMPONENTS = 40;

interface BuildOptions {
  /** Session the notes belong to, needed to turn a capture into an attachment. */
  logId: number | null;
  /** The agent accepts image content blocks. When it does not, captures are left out entirely. */
  canSendImages?: boolean;
}

/**
 * Turn annotations into the prompt that asks the agent to answer them.
 *
 * Sibling of `diff/build-review-feedback.ts` and returns the same content-block shape, but this
 * one is a question rather than a review verdict — it must not read as "changes requested".
 *
 * Async only because of canvas captures: they are files on disk that have to be read, downscaled
 * and (for a remote connection) copied to the far side before they can ride along as image blocks.
 */
export async function buildAnnotationBlocks(
  annotations: Annotation[],
  options: BuildOptions = { logId: null },
): Promise<JsonValue[]> {
  if (annotations.length === 0) return [];

  let text = "# Annotations: please answer\n\n";
  text +=
    "I left the notes below on your work. Answer each one. " +
    "Ask before changing anything you are unsure about.\n\n";

  const diffByFile = new Map<string, string[]>();
  for (const a of annotations) {
    if (a.kind !== "diff") continue;
    const list = diffByFile.get(a.filePath) ?? [];
    const anchor = commentAnchor(a);
    list.push(anchor ? `${anchor}: ${a.text}` : a.text);
    diffByFile.set(a.filePath, list);
  }

  for (const [filePath, notes] of diffByFile) {
    text += `## \`${filePath}\`\n`;
    for (const note of notes) text += `- ${note}\n`;
    text += "\n";
  }

  const planNotes = annotations.filter((a) => a.kind === "plan");
  if (planNotes.length > 0) {
    text += "## Plan\n";
    for (const a of planNotes) {
      if (a.kind !== "plan") continue;
      text += `> ${a.quote.replace(/\n+/g, " ")}\n\n${a.text}\n\n`;
    }
  }

  const blocks: JsonValue[] = [{ type: "text", text }];

  // Canvas notes cannot be folded into the block above: each one may be followed by its capture,
  // and content blocks are a flat ordered list, so an image only reads as belonging to a note if
  // it directly follows that note's text.
  for (const a of annotations) {
    if (a.kind !== "canvas") continue;

    let section = `## Canvas “${a.surfaceTitle}” (surface \`${a.surfaceId}\`)\n\n`;
    section +=
      a.componentIds.length > 0
        ? `Components: ${a.componentIds.map((id) => `\`${id}\``).join(", ")}\n\n`
        : "About the surface as a whole, not one component.\n\n";
    if (a.subtree) section += `\`\`\`json\n${a.subtree}\n\`\`\`\n\n`;
    section += `${a.text}\n`;

    const shot = await imageBlock(a.shotPath, options);
    if (shot) {
      section += "\nA screenshot of the region as it rendered follows this message.\n";
    }

    blocks.push({ type: "text", text: section });
    if (shot) blocks.push(shot);
  }

  return blocks;
}

/**
 * A capture is best-effort: it is evidence, and the component ids are the anchor. If the file has
 * gone or the connection cannot take it, the note still says what it said.
 */
async function imageBlock(
  shotPath: string | undefined,
  { logId, canSendImages }: BuildOptions,
): Promise<JsonValue | null> {
  if (!shotPath || !canSendImages || logId == null) return null;
  try {
    const prepared = await api.prepareExternalAttachments(
      logId,
      [{ path: shotPath, is_image: true }],
      false,
    );
    return (prepared[0]?.content_block as JsonValue) ?? null;
  } catch {
    return null;
  }
}

/**
 * Snapshot the annotated components as JSON, to be stored on the note when it is written.
 *
 * Taken at creation for the same reason the capture is: the agent rewrites the surface as it
 * works, and a note has to keep describing what the user was looking at. Data bindings are left
 * as the `/pointer` strings the agent authored — those are more useful to it than the resolved
 * values, and they are what it will edit.
 */
export function describeCanvasSubtree(surface: CanvasSurface, ids: string[]): string | undefined {
  if (ids.length === 0) return undefined;

  const byId = new Map(surface.components.map((c) => [c.id, c]));
  const collected: CanvasComponent[] = [];
  const seen = new Set<string>();
  const queue = [...ids];

  while (queue.length > 0 && collected.length < MAX_SUBTREE_COMPONENTS) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const component = byId.get(id);
    if (!component) continue;
    collected.push(trimInlineData(component));
    if (component.children) queue.push(...component.children);
  }

  if (collected.length === 0) return undefined;

  const json = JSON.stringify(collected, null, 2);
  return json.length > MAX_SUBTREE_CHARS
    ? `${json.slice(0, MAX_SUBTREE_CHARS)}\n… truncated`
    : json;
}

/**
 * Guard against a component that inlined its rows instead of pushing them through `canvas_data`.
 * One `DataTable` like that is larger than every other note in the prompt put together.
 */
function trimInlineData(component: CanvasComponent): CanvasComponent {
  const trimmed: CanvasComponent = { id: component.id, component: component.component };
  for (const [key, value] of Object.entries(component)) {
    if (key === "id" || key === "component") continue;
    // `children` is structure, not data: a shortened list would read as the surface having fewer
    // children than it does.
    if (key !== "children" && Array.isArray(value) && value.length > 5) {
      trimmed[key] = [...value.slice(0, 5), `… ${value.length - 5} more`];
    } else {
      trimmed[key] = value;
    }
  }
  return trimmed;
}
