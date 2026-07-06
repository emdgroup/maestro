import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Label } from "@/ui/label";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "@/ui/combobox";
import {
  useListAzureDevOpsProjects,
  useListAzureDevOpsRepos,
  useRefreshAzureDevOpsRepos,
} from "@/services/integration-lookup.service";

export function AzureDevOpsRepoForm({
  onRepoSelected,
  disabled,
}: {
  onRepoSelected: (url: string, name: string) => void;
  disabled?: boolean;
}) {
  const [selectedProject, setSelectedProject] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [repoSearch, setRepoSearch] = useState("");

  const projectsQuery = useListAzureDevOpsProjects();
  const projects = projectsQuery.data ?? [];
  const pq = projectSearch.toLowerCase();
  const filteredProjects = pq
    ? projects.filter((p) => p.name.toLowerCase().includes(pq))
    : projects;

  const reposQuery = useListAzureDevOpsRepos(selectedProject, selectedProject.length >= 1);
  const refreshRepos = useRefreshAzureDevOpsRepos(selectedProject);
  const repos = reposQuery.data ?? [];
  const rq = repoSearch.toLowerCase();
  const filteredRepos = rq ? repos.filter((r) => r.name.toLowerCase().includes(rq)) : repos;

  return (
    <>
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Project</Label>
        <Combobox
          value={selectedProject}
          onValueChange={(v) => setSelectedProject(v ?? "")}
          onInputValueChange={(v) => setProjectSearch(v)}
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
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Repository</Label>
          {selectedProject && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground transition-colors"
              onClick={refreshRepos}
            >
              <RefreshCw className="size-3.5" />
            </button>
          )}
        </div>
        <Combobox
          value=""
          onValueChange={(v) => {
            if (!v) return;
            const repo = repos.find((r) => r.name === v);
            const cloneUrl = repo?.clone_url ?? "";
            if (cloneUrl) onRepoSelected(cloneUrl, v);
          }}
          onInputValueChange={(v) => setRepoSearch(v)}
          filter={null}
        >
          <ComboboxInput
            placeholder={
              !selectedProject
                ? "Select a project first"
                : reposQuery.isLoading
                  ? "Loading…"
                  : `Search in ${selectedProject}…`
            }
            disabled={disabled || !selectedProject}
          />
          <ComboboxContent>
            <ComboboxList>
              {reposQuery.isLoading && <ComboboxEmpty>Loading…</ComboboxEmpty>}
              {!reposQuery.isLoading && repos.length === 0 && (
                <ComboboxEmpty>No repositories found</ComboboxEmpty>
              )}
              {filteredRepos.map((r) => (
                <ComboboxItem key={r.id} value={r.name}>
                  <span className="font-medium">{r.name}</span>
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>
    </>
  );
}
