/**
 * Slash-command detection for user messages.
 *
 * Runs as a rehype plugin *after* rehypeSanitize, not as a string pre-pass on the
 * markdown, so the parser decides what is prose and what is code: a `/api/foo`
 * pasted inside a fence is a `code`/`pre` subtree here and is skipped, where a
 * regex over the raw text would have rewritten it. Running after sanitize also
 * means the emitted node needs no entry in the sanitize schema.
 *
 * The plugin only marks candidates — it never looks at the agent's command list.
 * Membership is checked at render time (MarkdownCommandComponent), so a list that
 * arrives late does not force the whole document to re-parse.
 */

/** Minimal structural hast — avoids depending on @types/hast being hoisted. */
type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/** Tag the plugin emits. Not a real element — MARKDOWN_COMPONENTS renders it. */
export const COMMAND_TAG = "maestro-command";

/**
 * `/name`, at the start or after whitespace, where the name is command-shaped:
 * lowercase-kebab with optional `namespace:` or `namespace-` prefix, no spaces,
 * no slashes, under 64 chars.
 *
 * The trailing lookahead rejects the whole token class, not just `/`, because a
 * bare `(?!\/)` would let the engine backtrack: `/usr/local` would give up the
 * `r` and match `/us` instead.
 */
const SLASH_COMMAND_RE = /(^|\s)\/([a-zA-Z0-9][a-zA-Z0-9_:-]{0,63})(?![a-zA-Z0-9_:\-/])/g;

/** Subtrees where a `/token` is never a command. */
const OPAQUE_TAGS = new Set(["code", "pre", "a", COMMAND_TAG]);

/** Returns the replacement nodes for a text node, or null when it has no match. */
export function splitCommandText(value: string): HastNode[] | null {
  SLASH_COMMAND_RE.lastIndex = 0;
  const out: HastNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = SLASH_COMMAND_RE.exec(value)) !== null) {
    const start = match.index + match[1].length; // skip the leading whitespace capture
    if (start > last) out.push({ type: "text", value: value.slice(last, start) });
    out.push({
      type: "element",
      tagName: COMMAND_TAG,
      properties: { dataCommand: match[2] },
      children: [{ type: "text", value: `/${match[2]}` }],
    });
    last = start + 1 + match[2].length;
  }
  if (out.length === 0) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function visit(node: HastNode): void {
  const children = node.children;
  if (!children) return;
  const out: HastNode[] = [];
  let changed = false;
  for (const child of children) {
    if (child.type === "element") {
      if (!OPAQUE_TAGS.has(child.tagName ?? "")) visit(child);
      out.push(child);
      continue;
    }
    const parts = child.type === "text" && child.value ? splitCommandText(child.value) : null;
    if (!parts) {
      out.push(child);
      continue;
    }
    changed = true;
    out.push(...parts);
  }
  if (changed) node.children = out;
}

export function rehypeSlashCommands() {
  return (tree: HastNode) => {
    visit(tree);
  };
}
