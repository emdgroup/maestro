import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import type { PromptInput } from "@/types/bindings";

export const promptQueryKeys = {
  base: ["prompts"] as const,
  shared: ["prompts", "shared"] as const,
  project: (projectId: number) => ["prompts", "project", projectId] as const,
};

/**
 * One collection, favorites first then newest, in the backend's order: the project's from its
 * daemon, or the app's shared one. Apart, so a daemon that is down blanks only its own column.
 */
export function usePromptsQuery(projectId: number, shared: boolean) {
  return useQuery({
    queryKey: shared ? promptQueryKeys.shared : promptQueryKeys.project(projectId),
    queryFn: () => api.listPrompts(projectId, shared),
  });
}

// A copy writes to the other collection, so a mutation invalidates both.
function useInvalidatePrompts() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: promptQueryKeys.base });
}

/** Create a prompt, or replace the one `prompt.id` names. */
export function useSavePromptMutation() {
  const invalidate = useInvalidatePrompts();
  return useMutation({
    mutationFn: ({ projectId, prompt }: { projectId: number; prompt: PromptInput }) =>
      api.savePrompt(projectId, prompt),
    onSuccess: invalidate,
    onError: createErrorToastHandler("Failed to save the prompt"),
  });
}

export function useSetPromptFavoriteMutation() {
  const invalidate = useInvalidatePrompts();
  return useMutation({
    mutationFn: ({
      projectId,
      id,
      shared,
      favorite,
    }: {
      projectId: number;
      id: number;
      shared: boolean;
      favorite: boolean;
    }) => api.setPromptFavorite(projectId, id, shared, favorite),
    onSuccess: invalidate,
    onError: createErrorToastHandler("Failed to update the prompt"),
  });
}

/** Copy a prompt into the other collection; `shared` names the one it is copied from. */
export function useCopyPromptMutation() {
  const invalidate = useInvalidatePrompts();
  return useMutation({
    mutationFn: ({ projectId, id, shared }: { projectId: number; id: number; shared: boolean }) =>
      api.copyPrompt(projectId, id, shared),
    onSuccess: invalidate,
    onError: createErrorToastHandler("Failed to copy the prompt"),
  });
}

export function useDeletePromptMutation() {
  const invalidate = useInvalidatePrompts();
  return useMutation({
    mutationFn: ({ projectId, id, shared }: { projectId: number; id: number; shared: boolean }) =>
      api.deletePrompt(projectId, id, shared),
    onSuccess: invalidate,
    onError: createErrorToastHandler("Failed to delete the prompt"),
  });
}
