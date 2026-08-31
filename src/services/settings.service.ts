import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { toast } from "sonner";

import { connectionKeyStr } from "@/lib/connection-utils";

import type { AppSettings, ConnectionCapacitySettings, ConnectionKey } from "@/types/bindings";

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
  logLevels: () => [...settingsQueryKeys.base, "logLevels"] as const,
  logDirectory: () => [...settingsQueryKeys.base, "logDirectory"] as const,
  connectionCapacity: (connection: ConnectionKey) =>
    [...settingsQueryKeys.base, "connectionCapacity", connectionKeyStr(connection)] as const,
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
 * Query hook for the log levels the backend accepts.
 * Fetched rather than hardcoded so the UI cannot offer a level Rust will not parse.
 */
export function useLogLevels() {
  return useQuery({
    queryKey: settingsQueryKeys.logLevels(),
    queryFn: () => api.getLogLevels(),
    staleTime: Infinity,
  });
}

/**
 * Query hook for the directory logs are actually being written to.
 * This is how a user finds the file to attach to a bug report, so it resolves the same path the
 * logger uses rather than reconstructing it in the frontend.
 */
export function useLogDirectory() {
  return useQuery({
    queryKey: settingsQueryKeys.logDirectory(),
    queryFn: () => api.getLogDirectory(),
    staleTime: Infinity,
  });
}

/**
 * How many agents may run at once on one connection.
 *
 * Per connection rather than app-wide because the constraint is memory, and a machine's memory is
 * shared by every project pointed at it.
 */
export function useConnectionCapacity(connection: ConnectionKey) {
  return useQuery({
    queryKey: settingsQueryKeys.connectionCapacity(connection),
    queryFn: () => api.getConnectionCapacity(connection),
    staleTime: Infinity,
  });
}

export function useSaveConnectionCapacity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      connection,
      settings,
    }: {
      connection: ConnectionKey;
      settings: ConnectionCapacitySettings;
    }) => api.saveConnectionCapacity(connection, settings),
    onSuccess: (_data, { connection }) => {
      void queryClient.invalidateQueries({
        queryKey: settingsQueryKeys.connectionCapacity(connection),
      });
    },
    onError: createErrorToastHandler("Failed to save the agent limit"),
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
export function useSaveSettings({ successToast = true }: { successToast: boolean }) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (settings: AppSettings) => api.saveSettings(settings),
    onSuccess: () => {
      if (successToast) {
        toast.success("Settings saved");
      }
      // Invalidate settings list so it refetches with updated values
      void queryClient.invalidateQueries({ queryKey: settingsQueryKeys.lists() });
      // The resolved log path depends on log_directory, so it can go stale on any save.
      void queryClient.invalidateQueries({ queryKey: settingsQueryKeys.logDirectory() });
    },
    onError: createErrorToastHandler("Failed to save settings"),
  });
}
