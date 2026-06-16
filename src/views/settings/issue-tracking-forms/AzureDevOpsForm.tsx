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
import { useListAzureDevOpsProjects } from "@/services/integration-lookup.service";

interface Props {
  fields: Record<string, string>;
  onFieldsChange: (fields: Record<string, string>) => void;
  showValidation?: boolean;
}

export function AzureDevOpsForm({ fields, onFieldsChange, showValidation }: Props) {
  const projectName = fields.project_name ?? "";
  const { data: projects = [], isLoading } = useListAzureDevOpsProjects();
  const [search, setSearch] = useState("");

  const q = search.toLowerCase();
  const filteredProjects = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;

  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium" required>
        Project
      </Label>
      {showValidation && !projectName && (
        <p className="text-xs text-destructive">Project is required</p>
      )}
      <Combobox
        value={projectName}
        onValueChange={(v) => onFieldsChange({ ...fields, project_name: v ?? "" })}
        onInputValueChange={(v) => setSearch(v)}
        filter={null}
      >
        <ComboboxInput
          placeholder={isLoading ? "Loading projects…" : "Search projects…"}
          showClear={!!projectName}
        />
        <ComboboxContent>
          <ComboboxList>
            {isLoading && <ComboboxEmpty>Loading…</ComboboxEmpty>}
            {!isLoading && filteredProjects.length === 0 && (
              <ComboboxEmpty>No projects found</ComboboxEmpty>
            )}
            {filteredProjects.map((p) => (
              <ComboboxItem key={p.id} value={p.name}>
                <span className="font-medium">{p.name}</span>
                {p.description && (
                  <span className="text-muted-foreground text-xs truncate ml-1">
                    {p.description}
                  </span>
                )}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}
