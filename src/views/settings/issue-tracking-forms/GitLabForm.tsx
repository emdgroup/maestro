import { useEffect, useState } from "react";
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
  showValidation?: boolean;
}

export function GitLabForm({ fields, onFieldsChange, showValidation }: Props) {
  const projectPath = fields.project_path ?? "";
  const { data: projects = [], isLoading } = useListGitlabProjects();
  const [search, setSearch] = useState("");

  // A project path can arrive without its numeric id — from git-remote detection that
  // couldn't reach the API, or a hand-edited settings.json. fetch_remote_issues needs the
  // id, so backfill it as soon as the project list is here.
  useEffect(() => {
    if (!projectPath || fields.project_key) return;
    const match = projects.find((p) => p.path_with_namespace === projectPath);
    if (match) onFieldsChange({ ...fields, project_key: String(match.id) });
  }, [projectPath, fields, projects, onFieldsChange]);

  const q = search.toLowerCase();
  const filteredProjects = q
    ? projects.filter(
        (p) => p.path_with_namespace.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
      )
    : projects;

  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium" required>
        Project
      </Label>
      {showValidation && !projectPath && (
        <p className="text-xs text-destructive">Project is required</p>
      )}
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
