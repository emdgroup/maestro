import { api } from "@/lib/tauri-utils";
import { commentAnchor } from "@/components/execution/diff/comment-anchor";
import type { Annotation } from "@/store/annotationStore";
import type { JsonValue } from "@/types/bindings";

/** Past this the subtree stops being context and starts being the whole prompt. */
export const MAX_SUBTREE_CHARS = 2000;

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
        ? `Elements: ${a.componentIds.map((id) => `\`${id}\``).join(", ")}\n\n`
        : "About the surface as a whole, not one element.\n\n";
    if (a.subtree) section += `\`\`\`html\n${a.subtree}\n\`\`\`\n\n`;
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
