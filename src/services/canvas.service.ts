import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import type { CanvasSurface } from "@/components/execution/activity/types";
import { surfaceFromHtml, surfaceToHtml } from "@/components/execution/activity/canvas/canvas-file";

export async function saveCanvasSurface(
  projectId: number,
  logId: number,
  surface: CanvasSurface,
): Promise<void> {
  await api.saveCanvasSurface(projectId, logId, surface.surfaceId, surfaceToHtml(surface));
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
  const files = await api.loadSavedCanvases(projectId, logId);
  return files.map(surfaceFromHtml).filter((s): s is CanvasSurface => s !== null);
}
