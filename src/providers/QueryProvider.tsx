import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode, useState } from "react";

interface QueryProviderProps {
  children: ReactNode;
}

/**
 * Provider for TanStack Query
 * Configures default options for all queries and mutations
 */
export function QueryProvider({ children }: QueryProviderProps) {
  // Create QueryClient instance once per app lifecycle
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1, // Retry failed queries once
            refetchOnWindowFocus: false, // Disable auto-refetch by default
            staleTime: 0, // Data becomes stale immediately (queries opt-in to longer)
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
