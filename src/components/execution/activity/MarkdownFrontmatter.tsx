/**
 * YAML frontmatter rendering.
 *
 * CommonMark has no notion of frontmatter, so a document opening with `---`
 * renders as a thematic break followed by a paragraph in which every `key: value`
 * line is soft-wrapped into one run of prose. Skill files, agent definitions and
 * most project docs open that way, so the block is pulled off the string before
 * react-markdown ever sees it and rendered as a key/value table instead.
 *
 * The split happens here rather than through remark-frontmatter plus a custom
 * mdast node: the table never enters the hast pipeline, so it needs no entry in
 * `sanitizeSchema` and the markup is ours to style.
 */

import type { ReactNode } from "react";
import { parse } from "yaml";

/**
 * A frontmatter block, which is only valid at offset 0. The terminator may be
 * `---` or `...`; CRLF is tolerated because these strings come from files read
 * off arbitrary machines.
 */
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** How deep to recurse before printing the remainder as JSON. */
const MAX_DEPTH = 4;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Splits a leading frontmatter block off `text`.
 *
 * Returns `data: null` and the text untouched whenever the block is absent,
 * unterminated, unparseable, or does not parse to a non-empty mapping — so
 * `---\nsome prose\n---` (a YAML string) keeps rendering as two rules and a
 * paragraph, exactly as it does today.
 */
export function splitFrontmatter(text: string): {
  data: Record<string, unknown> | null;
  body: string;
} {
  const unchanged = { data: null, body: text };
  if (!text.startsWith("---")) return unchanged;

  const match = FRONTMATTER_RE.exec(text);
  if (!match) return unchanged;

  let parsed: unknown;
  try {
    parsed = parse(match[1]);
  } catch {
    return unchanged;
  }
  if (!isMapping(parsed) || Object.keys(parsed).length === 0) return unchanged;

  return { data: parsed, body: text.slice(match[0].length) };
}

/** A cyclic graph is reachable through YAML aliases, and stringify throws on one. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "…";
  }
}

function Empty() {
  return <span className="text-muted-foreground/60">—</span>;
}

/**
 * Frontmatter values are literal YAML scalars, so they render as plain text —
 * never as markdown. `whitespace-pre-wrap` keeps block scalars readable.
 */
function FrontmatterValue({ value, depth }: { value: unknown; depth: number }): ReactNode {
  if (value === null || value === undefined) return <Empty />;
  if (typeof value !== "object") {
    return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
  }
  if (depth >= MAX_DEPTH) {
    return (
      <code className="px-1 py-0.5 rounded text-[11px] font-mono bg-muted">
        {safeStringify(value)}
      </code>
    );
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <Empty />;
    if (value.every((item) => typeof item !== "object" || item === null)) {
      return (
        <ul className="list-disc pl-4 space-y-0.5">
          {value.map((item, i) => (
            <li key={i}>
              <FrontmatterValue value={item} depth={depth + 1} />
            </li>
          ))}
        </ul>
      );
    }
    return (
      <div className="space-y-2">
        {value.map((item, i) => (
          <FrontmatterValue key={i} value={item} depth={depth + 1} />
        ))}
      </div>
    );
  }

  const entries = Object.keys(value);
  if (entries.length === 0) return <Empty />;
  return <KeyValueTable data={value as Record<string, unknown>} depth={depth + 1} />;
}

/**
 * Static, unlike the markdown tables in MarkdownTableSort: there is no header
 * row to click and sorting a key/value pair list means nothing.
 */
function KeyValueTable({ data, depth }: { data: Record<string, unknown>; depth: number }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-xs">
        <tbody>
          {Object.entries(data).map(([key, value], i) => {
            const border = i > 0 ? " border-t border-border/40" : "";
            return (
              <tr key={key}>
                <td
                  className={`w-px whitespace-nowrap px-3 py-2 align-top font-medium text-muted-foreground${border}`}
                >
                  {key}
                </td>
                <td className={`px-3 py-2 align-top text-foreground/80${border}`}>
                  <FrontmatterValue value={value} depth={depth} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function FrontmatterTable({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="my-3">
      <KeyValueTable data={data} depth={0} />
    </div>
  );
}
