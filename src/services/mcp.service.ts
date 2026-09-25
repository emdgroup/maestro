import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import type { ConnectionKey, McpServerConfig } from "@/types/bindings";

export const mcpQueryKeys = {
  list: (connection: ConnectionKey) => ["mcp-servers", connection] as const,
  listFor: (connection: ConnectionKey, projectPath: string) =>
    ["mcp-servers", connection, projectPath] as const,
  catalog: (query: string) => ["mcp-catalog", query] as const,
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
 * The GitHub MCP Registry: its curated list with no query, a search with one, a page of 50 at a
 * time. Cached for an hour, since the list barely moves and the registry rate-limits.
 */
export function useMcpCatalogQuery(query: string) {
  return useInfiniteQuery({
    queryKey: mcpQueryKeys.catalog(query),
    queryFn: ({ pageParam }) => api.mcpCatalog(query || null, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    staleTime: 60 * 60 * 1000,
    placeholderData: keepPreviousData,
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
    }: {
      server: McpServerConfig;
      previousName: string | null;
    }) => api.saveMcpServer(connection, server, previousName),
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
    }: {
      server: McpServerConfig;
      previousName: string | null;
    }) => api.testMcpServer(connection, server, previousName),
    onError: createErrorToastHandler("Failed to test the MCP server"),
  });
}
