import type { McpCatalogEntry, McpServerConfig } from "@/types/bindings";

/** Whether text still holds a registry placeholder, `{token}` or `<hint>`, the user must replace. */
export function needsValue(text: string): boolean {
  // `${VAR}` is expansion the server does itself, not a placeholder.
  return /(?<!\$)\{[A-Za-z_][\w-]*\}|<[A-Za-z_][\w-]*>/.test(text);
}

/** Installed servers whose name, command or URL contains the query, case-insensitively. */
export function filterServers(servers: McpServerConfig[], query: string): McpServerConfig[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return servers;
  return servers.filter((server) =>
    [server.name, server.command ?? "", server.url ?? "", ...server.args].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

/**
 * A package spec without its version or tag, lower-cased: `@scope/pkg@1.2` and `pkg==1.2` lose the
 * version, `ghcr.io/org/image:1.2` the tag. Flags are not packages.
 */
export function packageKey(arg: string): string | null {
  if (arg.startsWith("-")) return null;
  let key = arg.toLowerCase().replace(/==.*$/, "");
  const at = key.lastIndexOf("@");
  if (at > 0) key = key.slice(0, at);
  const colon = key.lastIndexOf(":");
  if (colon > key.lastIndexOf("/") && !key.includes("://")) key = key.slice(0, colon);
  return key || null;
}

function urlKey(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, "");
}

/**
 * The catalog entry an installed server came from: by the id it was installed with, else by a
 * package it runs or a URL it reaches, so one added by hand or in `.mcp.json` is recognised too.
 */
export function catalogMatch(
  server: McpServerConfig,
  entries: McpCatalogEntry[],
): McpCatalogEntry | undefined {
  const byId = entries.find((entry) => entry.id === server.catalog_id);
  if (byId) return byId;
  const args = new Set(server.args.map(packageKey).filter(Boolean));
  const url = server.url ? urlKey(server.url) : null;
  return entries.find(
    (entry) =>
      entry.packages.some((pkg) => args.has(packageKey(pkg))) ||
      (url !== null && entry.urls.some((candidate) => urlKey(candidate) === url)),
  );
}

/** Catalog entries whose name, id or description contains `query`, in the registry's order. */
export function filterCatalog(entries: McpCatalogEntry[], query: string): McpCatalogEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) =>
    [entry.name, entry.id, entry.description].some((field) => field.toLowerCase().includes(needle)),
  );
}

/**
 * A command line split the way a shell would: on spaces, with a quoted run kept whole and its
 * quotes dropped. Backslashes are left alone, so a Windows path survives.
 */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let quoted = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      quoted = true;
    } else if (/\s/.test(char)) {
      if (current || quoted) out.push(current);
      current = "";
      quoted = false;
    } else {
      current += char;
    }
  }
  if (current || quoted) out.push(current);
  return out;
}

/** An argument as it would be typed: quoted when it holds a space. */
export function quoteArg(arg: string): string {
  return /\s/.test(arg) || arg === "" ? `"${arg}"` : arg;
}

/** Whether a quote was opened and not closed, so a space still belongs to the argument. */
export function openQuote(text: string): boolean {
  return (text.match(/"/g)?.length ?? 0) % 2 === 1 || (text.match(/'/g)?.length ?? 0) % 2 === 1;
}

/** `KEY=value` lines, as in a `.env` file: comments, blank lines and `export ` are skipped. */
export function parseEnvLines(text: string): { key: string; value: string }[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const at = line.indexOf("=");
      return {
        key: line
          .slice(0, at)
          .replace(/^export\s+/, "")
          .trim(),
        value: line
          .slice(at + 1)
          .trim()
          .replace(/^(["'])(.*)\1$/, "$2"),
      };
    })
    .filter((pair) => pair.key !== "");
}

/** The `${VAR}` names a command line uses. */
export function usedVariables(args: string[]): string[] {
  return [
    ...new Set(
      args
        .join(" ")
        .match(/\$\{\w+\}/g)
        ?.map((match) => match.slice(2, -1)),
    ),
  ];
}

/**
 * A name for a server from what it runs: the package without its scope, version and the usual
 * `server-` / `-mcp` padding, or the host of its URL without `www.`, `mcp.` or `api.`.
 */
export function guessName(server: Pick<McpServerConfig, "transport" | "command" | "args" | "url">) {
  if (server.transport !== "stdio") {
    try {
      const host = new URL(server.url ?? "").hostname;
      return host.replace(/^(www|mcp|api)\./, "").split(".")[0] ?? "";
    } catch {
      return "";
    }
  }
  const pkg =
    server.args.find(
      (arg) => !arg.startsWith("-") && !arg.startsWith("${") && /[a-z]/i.test(arg),
    ) ??
    server.command ??
    "";
  return (
    pkg
      .split(/[/\\]/)
      .pop()
      ?.replace(/@.*$/, "")
      .replace(/==.*$/, "")
      .replace(/^(mcp-server-|server-)|(-mcp-server|-mcp|-server)$/g, "")
      .toLowerCase() ?? ""
  );
}

type JsonServer = {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  type?: unknown;
  transport?: unknown;
  headers?: unknown;
};

function entries(value: unknown): [string, string][] {
  return value && typeof value === "object"
    ? Object.entries(value).map(([key, item]) => [key, String(item)])
    : [];
}

/**
 * A server from an MCP JSON config: a whole `{"mcpServers": {...}}` block, a bare map of servers,
 * or one server. The first server of a map is taken; `skipped` says how many more there were.
 */
export function parseMcpJson(
  text: string,
): { server: Partial<McpServerConfig>; skipped: number } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!parsed || typeof parsed !== "object") return { error: "Not an MCP server config" };
  const root = parsed as Record<string, unknown>;
  const single = (value: unknown) =>
    !!value && typeof value === "object" && ("command" in value || "url" in value);
  let name: string | undefined;
  let server: JsonServer;
  let skipped = 0;
  if (single(root)) {
    server = root as JsonServer;
  } else {
    const map = (root.mcpServers ?? root.servers ?? root) as Record<string, unknown>;
    const names = Object.keys(map).filter((key) => single(map[key]));
    if (names.length === 0) return { error: "No MCP server in it" };
    name = names[0];
    server = map[name] as JsonServer;
    skipped = names.length - 1;
  }
  const kind = String(server.type ?? server.transport ?? "");
  const remote = typeof server.url === "string";
  return {
    server: {
      ...(name ? { name } : {}),
      transport: !remote ? "stdio" : kind === "sse" ? "sse" : "http",
      command: typeof server.command === "string" ? server.command : null,
      args: Array.isArray(server.args) ? server.args.map(String) : [],
      env: entries(server.env).map(([key, value]) => ({ key, value, secret: false })),
      url: remote ? (server.url as string) : null,
      headers: entries(server.headers).map(([key, value]) => ({ key, value, secret: true })),
    },
    skipped,
  };
}

/** The server as the `mcpServers` block every README and `.mcp.json` uses. */
export function toMcpJson(server: McpServerConfig): string {
  const pairs = (rows: McpServerConfig["env"]) =>
    Object.fromEntries(rows.filter((row) => row.key).map((row) => [row.key, row.value]));
  const body =
    server.transport === "stdio"
      ? {
          command: server.command ?? "",
          args: server.args,
          ...(server.env.length ? { env: pairs(server.env) } : {}),
        }
      : {
          type: server.transport,
          url: server.url ?? "",
          ...(server.headers.length ? { headers: pairs(server.headers) } : {}),
        };
  return JSON.stringify({ mcpServers: { [server.name || "server"]: body } }, null, 2);
}
