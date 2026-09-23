import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import type { TemplateBody } from "@/types/bindings";

export const templateQueryKeys = {
  list: ["templates"] as const,
};

/** The user's own templates, app-wide and newest first. Built-ins are not stored and not here. */
export function useTemplatesQuery() {
  return useQuery({
    queryKey: templateQueryKeys.list,
    queryFn: () => api.listTemplates(),
  });
}

/** Create a template, or replace the one `id` names. */
export function useSaveTemplateMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      name,
      tag,
      body,
    }: {
      id: number | null;
      name: string;
      tag: string | null;
      body: TemplateBody;
    }) => api.saveTemplate(id, name, tag, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: templateQueryKeys.list });
    },
    onError: createErrorToastHandler("Failed to save the template"),
  });
}

export function useDeleteTemplateMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => api.deleteTemplate(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: templateQueryKeys.list });
    },
    onError: createErrorToastHandler("Failed to delete the template"),
  });
}
