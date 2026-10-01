import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import type { PromptInput } from "@/types/bindings";

export const promptQueryKeys = {
  base: ["prompts"] as const,
  list: (projectId: number) => ["prompts", projectId] as const,
};

/** The project's collection, from its daemon, then the app's shared one; favorites first in each. */
export function usePromptsQuery(projectId: number) {
  return useQuery({
    queryKey: promptQueryKeys.list(projectId),
    queryFn: async () => {
      const [own, shared] = await Promise.all([
        api.listPrompts(projectId, false),
        api.listPrompts(projectId, true),
      ]);
      return [...own, ...shared];
    },
  });
}

// Every project's list holds the shared prompts, so a change invalidates them all.
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
