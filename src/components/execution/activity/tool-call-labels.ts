/**
 * Pure labelling helpers for tool-call rows. Kept free of React and of the row renderer so the
 * permission notifications, which load at startup, can import them without pulling the markdown
 * renderer (katex, shiki, the diff viewer) into the entry bundle.
 */

import type { ToolCallItem } from "./types";

export function isTerminalKind(kind: string) {
  return /run_terminal|bash|shell|execute/.test(kind);
}

/**
 * A shell call's title is the command line, and that is the only thing that says
 * a row is about the repository from the moment it appears: `meta.git` is a
 * vendor field, filled in from the *response*, for a handful of verbs — so a
 * `git status` under any agent, and a `git add` still running under Claude Code,
 * both arrive with nothing on them.
 *
 * Anchored to a command position — line start, or after a pipe, semicolon,
 * `&&` or `(` — so `cd repo && git add .` counts while `cat .gitignore` and
 * `grep git README` do not. `gh` rides along: opening a PR is repository work
 * however it is spelled.
 */
export function isGitCommand(command: string): boolean {
  return /(^|[\n|;&(])\s*(git|gh)\s/.test(command);
}

const MCP_NAME = /^mcp__(.+?)__(.+)$/;

export function isMcpToolName(name: string | undefined): boolean {
  return name != null && MCP_NAME.test(name);
}

/**
 * An MCP tool reaches the stream under its wire name — `mcp__codegraph__codegraph_explore`
 * — which is a routing key, not a label: the prefix is noise, the two halves are
 * split by a doubled underscore, and a server conventionally repeats its own name
 * in every tool it exposes.
 *
 * A server names its own tools, so the word separator inside one is whatever that
 * author chose — `take_screenshot` and `query-docs` both occur, and either is
 * split on. The `__` between server and tool is the one part the host defines.
 *
 * Returns null for anything that is not that shape, so a title an agent wrote
 * itself is never rewritten.
 */
export function formatMcpToolName(name: string): string | null {
  const match = MCP_NAME.exec(name);
  if (!match) return null;

  // `plugin_context7_context7` — a plugin-hosted server carries the wrapper's
  // prefix and its own name twice.
  const serverWords = match[1].split("_").filter((w) => w && w !== "plugin");
  const server = serverWords.filter((w, i) => w !== serverWords[i - 1]).join("_");

  const words = match[2].split(/[_-]+/).filter(Boolean);
  // `codegraph__codegraph_explore` — the server's name again, on its own tool.
  if (words.length > 1 && words[0].toLowerCase() === server.toLowerCase()) words.shift();
  const tool = words.join(" ");

  const label = tool.charAt(0).toUpperCase() + tool.slice(1);
  // A one-tool server names it after itself — "Codegraph (codegraph)" says it twice.
  if (!server || tool.toLowerCase() === server.toLowerCase()) return label;
  return `${label} (${server})`;
}

/**
 * Shell calls carry both a command and the reason it was run. Collapsed, the
 * reason is the more useful of the two — the command is still shown in full once
 * the row is open, so nothing is lost.
 *
 * A content search has no such reason to offer, but its title is a command line
 * the adapter *invented* — `grep -n | head -80 "pat" C:\long\absolute\path`,
 * flags and all. Its inputs say the same thing without the theatre.
 */
export function rowLabel(tc: ToolCallItem): string {
  const meta = tc.meta;
  if (isTerminalKind(tc.kind) && meta?.description) return meta.description;
  if (meta?.searchPattern) {
    const scope = meta.searchScope ? ` in ${meta.searchScope}` : "";
    // Always "Search": the tool name varies by agent and says nothing the row
    // does not — the icon already carries which tool ran.
    return `Search "${meta.searchPattern}"${scope}`;
  }
  return formatMcpToolName(tc.title) ?? tc.title;
}
