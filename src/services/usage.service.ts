import { useEffect } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionKey, UsageQuery } from "@/types/bindings";
import { api } from "@/lib/tauri-utils";

export const usageQueryKeys = {
  base: ["usage"] as const,
  report: (query: UsageQuery) => [...usageQueryKeys.base, "report", query] as const,
};

/**
 * What the Usage view shows for a range and its filters, read from the app's mirror of every
 * connection's usage. The previous answer stays on screen while the next one loads. It is a local
 * query, so it also rereads every 30 seconds: Home's tile has no sync of its own to wait on.
 */
export function useUsageReport(query: UsageQuery) {
  return useQuery({
    queryKey: usageQueryKeys.report(query),
    queryFn: () => api.getUsageReport(query),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
}

const SYNC_INTERVAL_MS = 30_000;

/**
 * Bring the mirror up to date for every attached connection now and every 30 seconds while
 * mounted, then refresh the reports. Only attached connections can answer.
 */
export function useUsageSync(connections: ConnectionKey[]) {
  const queryClient = useQueryClient();
  const key = JSON.stringify(connections);
  useEffect(() => {
    const attached: ConnectionKey[] = JSON.parse(key);
    const sync = async () => {
      const results = await Promise.allSettled(attached.map((c) => api.syncUsage(c)));
      for (const result of results) {
        if (result.status === "rejected") console.warn("could not sync usage", result.reason);
      }
      void queryClient.invalidateQueries({ queryKey: usageQueryKeys.base });
    };
    void sync();
    const timer = setInterval(() => void sync(), SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [key, queryClient]);
}
