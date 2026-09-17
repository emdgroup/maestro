import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import type { CanvasSurface } from "@/components/execution/activity/types";

export async function saveCanvasSurface(
  projectId: number,
  logId: number,
  surface: CanvasSurface,
): Promise<void> {
  await api.saveCanvasSurface(projectId, logId, surface.surfaceId, surface as never);
}

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
    }) => saveCanvasSurface(projectId, logId, surface),
    onSuccess: () => toast.success("Canvas saved"),
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
    onSuccess: () => toast.success("Saved canvas deleted"),
    onError: createErrorToastHandler("Failed to delete canvas"),
  });
}

export async function loadSavedCanvases(
  projectId: number,
  logId: number,
): Promise<CanvasSurface[]> {
  return api.loadSavedCanvases(projectId, logId) as Promise<CanvasSurface[]>;
}
