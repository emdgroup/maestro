import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import type { ConnectionKey, McpOAuthSettings, McpServerConfig } from "@/types/bindings";

export const mcpQueryKeys = {
  list: (connection: ConnectionKey) => ["mcp-servers", connection] as const,
  listFor: (connection: ConnectionKey, projectPath: string) =>
    ["mcp-servers", connection, projectPath] as const,
  catalog: ["mcp-catalog"] as const,
};

/**
 * The MCP servers managed on the connection's machine, secret values blank, and the ones the
 * project's `.mcp.json` declares.
 */
export function useMcpServersQuery(connection: ConnectionKey, projectPath: string) {
  return useQuery({
    queryKey: mcpQueryKeys.listFor(connection, projectPath),
    queryFn: () => api.listMcpServers(connection, projectPath),
  });
}

/**
 * The whole GitHub MCP Registry, fetched once and kept until the refresh button asks again.
 */
export function useMcpCatalogQuery() {
  return useQuery({
    queryKey: mcpQueryKeys.catalog,
    queryFn: () => api.mcpCatalog(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

function useInvalidateMcpServers(connection: ConnectionKey) {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: mcpQueryKeys.list(connection) });
}

/** Create a server, or replace the one called `previousName`. */
export function useSaveMcpServerMutation(connection: ConnectionKey) {
  const invalidate = useInvalidateMcpServers(connection);
  return useMutation({
    mutationFn: ({
      server,
      previousName,
      oauth,
    }: {
      server: McpServerConfig;
      previousName: string | null;
      /** A sign-in from `useAuthorizeMcpServerMutation`, stored only once the save succeeds. */
      oauth?: string | null;
    }) => api.saveMcpServer(connection, server, previousName, oauth ?? null),
    onSuccess: invalidate,
    onError: createErrorToastHandler("Failed to save the MCP server"),
  });
}

export function useDeleteMcpServerMutation(connection: ConnectionKey) {
  const invalidate = useInvalidateMcpServers(connection);
  return useMutation({
    mutationFn: (name: string) => api.deleteMcpServer(connection, name),
    onSuccess: invalidate,
    onError: createErrorToastHandler("Failed to remove the MCP server"),
  });
}

/** Start or reach the server and list its tools. A failure comes back as a result, not a throw. */
export function useTestMcpServerMutation(connection: ConnectionKey) {
  return useMutation({
    mutationFn: ({
      server,
      previousName,
      oauth,
    }: {
      server: McpServerConfig;
      previousName: string | null;
      oauth?: string | null;
    }) => api.testMcpServer(connection, server, previousName, oauth ?? null),
    onError: createErrorToastHandler("Failed to test the MCP server"),
  });
}

/**
 * Sign in to a remote server in the browser. Resolves to an id the token is held under in the
 * app's memory until a save stores it; the token itself never comes to the webview.
 */
export function useAuthorizeMcpServerMutation(connection: ConnectionKey) {
  return useMutation({
    mutationFn: ({
      url,
      settings,
      storedAs,
    }: {
      url: string;
      settings: McpOAuthSettings | null;
      /** The saved server being edited, whose stored client secret or key fills a blank one. */
      storedAs: string | null;
    }) => api.authorizeMcpServer(connection, url, settings, storedAs),
    onError: createErrorToastHandler("Failed to sign in to the MCP server"),
  });
}

/** Drop a sign-in the user did not save. */
export function discardMcpAuthorization(id: string) {
  void api.discardMcpAuthorization(id);
}

/**
 * Whether the server at `url` needs an OAuth sign-in, asked once per URL. Unknown while `url` is
 * empty, and when the server cannot be reached from here.
 */
export function useMcpRequiresOauthQuery(url: string) {
  return useQuery({
    queryKey: ["mcp-requires-oauth", url] as const,
    queryFn: () => api.mcpRequiresOauth(url),
    enabled: /^https?:\/\/\S+$/.test(url),
    staleTime: Infinity,
    retry: false,
  });
}
