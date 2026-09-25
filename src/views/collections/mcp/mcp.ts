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
