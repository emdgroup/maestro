import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { toast } from "sonner";

import type { AppSettings } from "@/types/bindings";

/**
 * Settings service providing type-safe operations for application settings.
 * All settings-related IPC calls are centralized here.
 */

/**
 * Query key factory for settings operations
 * Settings are global app state with stable query keys
 */
const settingsQueryKeys = {
  base: ["settings"] as const,
  lists: () => [...settingsQueryKeys.base, "list"] as const,
  accentColor: () => [...settingsQueryKeys.base, "accentColor"] as const,
};

/**
 * Query hook for fetching all application settings
 * Settings rarely change, so staleTime is 10 minutes
 */
export function useSettings() {
  return useQuery({
    queryKey: settingsQueryKeys.lists(),
    queryFn: () => api.getSettings(),
    staleTime: Infinity,
  });
}

/**
 * Query hook for fetching system accent color
 * OS accent color rarely changes (persists until restart), so staleTime is very high
 */
export function useSystemAccentColorQuery() {
  return useQuery({
    queryKey: settingsQueryKeys.accentColor(),
    queryFn: () => api.getSystemAccentColor(),
    staleTime: Infinity, // OS color doesn't change until app restart
    refetchOnWindowFocus: true, // But refetch if user switches windows (may have changed appearance)
  });
}

/**
 * Mutation hook for saving application settings
 * Invalidates settings cache after successful save
 */
export function useSaveSettings({ successToast = true } : { successToast: boolean }) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (settings: AppSettings) => api.saveSettings(settings),
    onSuccess: () => {
      if (successToast) {
        toast.success("Settings saved");
      }
      // Invalidate settings list so it refetches with updated values
      void queryClient.invalidateQueries({ queryKey: settingsQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to save settings"),
  });
}
