import { useState } from "react";
import { Label } from "@/ui/label";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxEmpty,
  ComboboxSeparator,
} from "@/ui/combobox";
import { useListJiraProjects } from "@/services/integration-lookup.service";

interface Props {
  fields: Record<string, string>;
  onFieldsChange: (fields: Record<string, string>) => void;
  showValidation?: boolean;
}

export function JiraCloudForm({ fields, onFieldsChange, showValidation }: Props) {
  const projectKey = fields.project_key ?? "";
  const { data: projects = [], isLoading } = useListJiraProjects();
  const [search, setSearch] = useState("");

  const q = search.toLowerCase();
  const filtered = q
    ? projects.filter((p) => p.key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
    : projects;
  const favourites = filtered.filter((p) => p.is_favourite);
  const others = filtered.filter((p) => !p.is_favourite);

  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium" required>Project</Label>
      {showValidation && !projectKey && (
        <p className="text-xs text-destructive">Project is required</p>
      )}
      <Combobox
        value={projectKey}
        onValueChange={(v) => onFieldsChange({ ...fields, project_key: v ?? "" })}
        onInputValueChange={(v) => setSearch(v)}
        filter={null}
      >
        <ComboboxInput
          placeholder={isLoading ? "Loading projects…" : "Search projects…"}
          showClear={!!projectKey}
        />
        <ComboboxContent>
          <ComboboxList>
            {isLoading && <ComboboxEmpty>Loading…</ComboboxEmpty>}
            {!isLoading && projects.length === 0 && (
              <ComboboxEmpty>No projects found</ComboboxEmpty>
            )}
            {favourites.length > 0 && (
              <ComboboxGroup>
                <ComboboxLabel>Starred</ComboboxLabel>
                {favourites.map((p) => (
                  <JiraProjectItem
                    key={p.key}
                    projectKey={p.key}
                    name={p.name}
                    avatarUrl={p.avatar_url}
                  />
                ))}
              </ComboboxGroup>
            )}
            {favourites.length > 0 && others.length > 0 && <ComboboxSeparator />}
            {others.length > 0 && (
              <ComboboxGroup>
                {favourites.length > 0 && <ComboboxLabel>All projects</ComboboxLabel>}
                {others.map((p) => (
                  <JiraProjectItem
                    key={p.key}
                    projectKey={p.key}
                    name={p.name}
                    avatarUrl={p.avatar_url}
                  />
                ))}
              </ComboboxGroup>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}

function JiraProjectItem({
  projectKey,
  name,
  avatarUrl,
}: {
  projectKey: string;
  name: string;
  avatarUrl: string | null;
}) {
  return (
    <ComboboxItem value={projectKey}>
      {avatarUrl && (
        <img
          src={avatarUrl}
          className="size-4 rounded-sm shrink-0"
          alt=""
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      )}
      <span className="font-mono font-medium text-xs">{projectKey}</span>
      <span className="text-muted-foreground truncate">{name}</span>
    </ComboboxItem>
  );
}
