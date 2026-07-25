import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import type { CanvasSurface } from "@/components/execution/activity/types";

export function useSaveCanvasSurfaceMutation() {
  return useMutation({
    mutationFn: ({
      projectId,
      logId,
      surface,
    }: {
      projectId: number;
      logId: number;
      surface: CanvasSurface;
    }) => api.saveCanvasSurface(projectId, logId, surface.surfaceId, surface as never),
    onError: createErrorToastHandler("Failed to save canvas"),
  });
}

export function useDeleteCanvasSurfaceMutation() {
  return useMutation({
    mutationFn: ({
      projectId,
      logId,
      surfaceId,
    }: {
      projectId: number;
      logId: number;
      surfaceId: string;
    }) => api.deleteCanvasSurface(projectId, logId, surfaceId),
    onError: createErrorToastHandler("Failed to delete canvas"),
  });
}

export async function loadSavedCanvases(
  projectId: number,
  logId: number,
): Promise<CanvasSurface[]> {
  return api.loadSavedCanvases(projectId, logId) as Promise<CanvasSurface[]>;
}
