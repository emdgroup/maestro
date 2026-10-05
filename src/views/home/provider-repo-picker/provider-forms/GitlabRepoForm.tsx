import { useState } from "react";
import { Label } from "@/ui/label";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "@/ui/combobox";
import { useListGitlabProjects } from "@/services/integration-lookup.service";

export function GitLabRepoForm({
  onRepoSelected,
  disabled,
}: {
  onRepoSelected: (url: string, name: string) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const projectsQuery = useListGitlabProjects();
  const projects = projectsQuery.data ?? [];
  const q = search.toLowerCase();
  const filtered = q
    ? projects.filter((p) => p.path_with_namespace.toLowerCase().includes(q))
    : projects;

  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium">Project</Label>
      <Combobox
        value=""
        onValueChange={(v) => {
          if (!v) return;
          const project = projects.find((p) => p.path_with_namespace === v);
          const cloneUrl = project?.clone_url ?? "";
          if (cloneUrl) onRepoSelected(cloneUrl, project?.name ?? v);
        }}
        onInputValueChange={(v) => setSearch(v)}
        filter={null}
      >
        <ComboboxInput
          placeholder={projectsQuery.isLoading ? "Loading…" : "Search projects…"}
          disabled={disabled || projectsQuery.isLoading}
        />
        <ComboboxContent>
          <ComboboxList>
            {projectsQuery.isLoading && <ComboboxEmpty>Loading…</ComboboxEmpty>}
            {!projectsQuery.isLoading && projects.length === 0 && (
              <ComboboxEmpty>No projects found</ComboboxEmpty>
            )}
            {filtered.map((p) => (
              <ComboboxItem key={p.id} value={p.path_with_namespace}>
                <span className="font-medium">{p.path_with_namespace}</span>
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}
