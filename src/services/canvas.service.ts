import { useMutation } from "@tanstack/react-query";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import type { CanvasSurface } from "@/components/execution/activity/types";
import { surfaceFromHtml, surfaceToHtml } from "@/components/execution/activity/canvas/canvas-file";

export async function saveCanvasSurface(sessionId: string, surface: CanvasSurface): Promise<void> {
  await api.saveCanvasSurface(sessionId, surface.surfaceId, surfaceToHtml(surface));
}

/**
 * Removes the autosaved file, so a closed surface does not come back on the next session load.
 *
 * Deliberately quiet on success: closing the surface is what the user sees, and the file behind it
 * is Maestro's bookkeeping. The backend treats a missing file as success, so closing a surface the
 * autosave has not written yet is not an error.
 */
export function useDeleteCanvasSurfaceMutation() {
  return useMutation({
    mutationFn: ({ sessionId, surfaceId }: { sessionId: string; surfaceId: string }) =>
      api.deleteCanvasSurface(sessionId, surfaceId),
    onError: createErrorToastHandler("Failed to delete the saved canvas file"),
  });
}

/**
 * Write the surface wherever the user points the dialog.
 *
 * Always over the local connection: the file picker is the host's, so the path it returns names a
 * directory on this machine even when the session itself runs over SSH, WSL or in a container.
 *
 * Distinct from `saveCanvasSurface` above, which is the session's own autosave into
 * `.maestro/canvases/` and is what a restored session reads back. This one is an export — nothing
 * reads what it writes.
 */
export function useExportCanvasSurfaceMutation() {
  return useMutation({
    mutationFn: async (surface: CanvasSurface) => {
      const path = await save({
        defaultPath: `${surface.surfaceId}.html`,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (!path) return null;
      await api.writeFile({ type: "local" }, path, surfaceToHtml(surface));
      return path;
    },
    onSuccess: (path) => {
      if (path) toast.success(`Canvas exported to ${path}`);
    },
    onError: createErrorToastHandler("Failed to export canvas"),
  });
}

export async function loadSavedCanvases(sessionId: string): Promise<CanvasSurface[]> {
  const files = await api.loadSavedCanvases(sessionId);
  return files.map(surfaceFromHtml).filter((s): s is CanvasSurface => s !== null);
}

/**
 * Read a file the user picked on *this* machine — the picker is the host's, the same rule export
 * follows — and hand it back for `surfaceFromHtml` to classify.
 */
export async function readImportedCanvasFile(path: string): Promise<string> {
  return api.readFile({ type: "local" }, path);
}

/**
 * Put an imported document into the session's own workspace, so the agent can read it.
 *
 * Returns the absolute path on the machine the agent runs on, which for a remote session is not
 * the one the file was picked from.
 */
export async function saveCanvasImport(
  sessionId: string,
  fileName: string,
  html: string,
): Promise<string> {
  return api.saveCanvasImport(sessionId, fileName, html);
}
