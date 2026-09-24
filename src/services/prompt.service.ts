import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import type { PromptInput } from "@/types/bindings";

export const promptQueryKeys = {
  list: (projectId: number) => ["prompts", projectId] as const,
};

/** The project's own prompts and every shared one, most recently edited first, starred for this project. */
export function usePromptsQuery(projectId: number) {
  return useQuery({
    queryKey: promptQueryKeys.list(projectId),
    queryFn: () => api.listPrompts(projectId),
  });
}

// Every project's list holds the shared prompts, so a change invalidates them all.
function useInvalidatePrompts() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ["prompts"] });
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
      favorite,
    }: {
      projectId: number;
      id: number;
      favorite: boolean;
    }) => api.setPromptFavorite(projectId, id, favorite),
    onSuccess: invalidate,
    onError: createErrorToastHandler("Failed to update the prompt"),
  });
}

export function useSetPromptSharedMutation() {
  const invalidate = useInvalidatePrompts();
  return useMutation({
    mutationFn: ({ projectId, id, shared }: { projectId: number; id: number; shared: boolean }) =>
      api.setPromptShared(projectId, id, shared),
    onSuccess: invalidate,
    onError: createErrorToastHandler("Failed to update the prompt"),
  });
}

export function useDeletePromptMutation() {
  const invalidate = useInvalidatePrompts();
  return useMutation({
    mutationFn: (id: number) => api.deletePrompt(id),
    onSuccess: invalidate,
    onError: createErrorToastHandler("Failed to delete the prompt"),
  });
}
