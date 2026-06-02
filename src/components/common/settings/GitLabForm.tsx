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

interface Props {
  fields: Record<string, string>;
  onFieldsChange: (fields: Record<string, string>) => void;
}

export function GitLabForm({ fields, onFieldsChange }: Props) {
  const projectPath = fields.project_path ?? "";
  const { data: projects = [], isLoading } = useListGitlabProjects();
  const [search, setSearch] = useState("");

  const q = search.toLowerCase();
  const filteredProjects = q
    ? projects.filter(
        (p) => p.path_with_namespace.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
      )
    : projects;

  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium">Project</Label>
      <Combobox
        value={projectPath}
        onValueChange={(v) => {
          const selected = projects.find((p) => p.path_with_namespace === v);
          onFieldsChange({
            ...fields,
            project_path: v ?? "",
            // Store numeric id in project_key — required by fetch_remote_issues
            project_key: selected ? String(selected.id) : (fields.project_key ?? ""),
          });
        }}
        onInputValueChange={(v) => setSearch(v)}
        filter={null}
      >
        <ComboboxInput
          placeholder={isLoading ? "Loading projects…" : "Search projects…"}
          showClear={!!projectPath}
        />
        <ComboboxContent>
          <ComboboxList>
            {isLoading && <ComboboxEmpty>Loading…</ComboboxEmpty>}
            {!isLoading && filteredProjects.length === 0 && (
              <ComboboxEmpty>No projects found</ComboboxEmpty>
            )}
            {filteredProjects.map((p) => (
              <ComboboxItem key={p.id} value={p.path_with_namespace}>
                <span className="font-medium">{p.path_with_namespace}</span>
                {p.name !== p.path_with_namespace.split("/").pop() && (
                  <span className="text-muted-foreground text-xs">{p.name}</span>
                )}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}
