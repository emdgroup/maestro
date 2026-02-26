import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ipc } from "./ipc";
import type { AppSettings } from "@/types/bindings";

/**
 * Settings service providing type-safe operations for application settings.
 * All settings-related IPC calls are centralized here.
 */
export const settingsService = {
  /**
   * Get all application settings
   */
  async getSettings(): Promise<AppSettings> {
    return ipc.invoke<AppSettings>("get_settings");
  },

  /**
   * Save application settings
   */
  async saveSettings(settings: AppSettings): Promise<void> {
    return ipc.invoke<void>("save_settings", { settings });
  },

  /**
   * Get system accent color
   */
  async getSystemAccentColor(): Promise<number[]> {
    return ipc.invoke<number[]>("get_system_accent_color");
  },
};

/**
 * Query key factory for settings operations
 * Settings are global app state with stable query keys
 */
export const settingsQueryKeys = {
  all: ["settings"] as const,
  lists: () => [...settingsQueryKeys.all, "list"] as const,
  accentColor: () => [...settingsQueryKeys.all, "accentColor"] as const,
};

/**
 * Query hook for fetching all application settings
 * Settings rarely change, so staleTime is 10 minutes
 */
export function useSettingsQuery() {
  return useQuery({
    queryKey: settingsQueryKeys.lists(),
    queryFn: () => settingsService.getSettings(),
    staleTime: 600000, // 10 minutes - settings rarely change
    refetchOnWindowFocus: true, // Refetch if user switches windows
  });
}

/**
 * Query hook for fetching system accent color
 * OS accent color rarely changes (persists until restart), so staleTime is very high
 */
export function useSystemAccentColorQuery() {
  return useQuery({
    queryKey: settingsQueryKeys.accentColor(),
    queryFn: () => settingsService.getSystemAccentColor(),
    staleTime: Infinity, // OS color doesn't change until app restart
    refetchOnWindowFocus: true, // But refetch if user switches windows (may have changed appearance)
  });
}

/**
 * Mutation hook for saving application settings
 * Invalidates settings cache after successful save
 */
export function useSaveSettingsMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (settings: AppSettings) => settingsService.saveSettings(settings),
    onSuccess: () => {
      toast.success("Settings saved");
      // Invalidate settings list so it refetches with updated values
      queryClient.invalidateQueries({ queryKey: settingsQueryKeys.lists() });
    },
    onError: (error) => {
      toast.error(`Failed to save settings: ${error}`);
    },
  });
}
