import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Label } from "@/ui/label";
import { Input } from "@/ui/input";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "@/ui/combobox";
import {
  useListBitbucketRepos,
  useRefreshBitbucketRepos,
  useListBitbucketProjects,
  useRefreshBitbucketProjects,
} from "@/services/integration-lookup.service";

export function BitbucketRepoForm({
  instanceUrl,
  onRepoSelected,
  disabled,
}: {
  instanceUrl: string | null;
  onRepoSelected: (url: string, name: string) => void;
  disabled?: boolean;
}) {
  const isServer = instanceUrl != null;

  return isServer ? (
    <BitbucketServerRepoForm onRepoSelected={onRepoSelected} disabled={disabled} />
  ) : (
    <BitbucketCloudRepoForm onRepoSelected={onRepoSelected} disabled={disabled} />
  );
}

function BitbucketCloudRepoForm({
  onRepoSelected,
  disabled,
}: {
  onRepoSelected: (url: string, name: string) => void;
  disabled?: boolean;
}) {
  const [workspace, setWorkspace] = useState("");
  const [repoSearch, setRepoSearch] = useState("");

  const repoList = useListBitbucketRepos(workspace, workspace.length >= 1);
  const refreshRepos = useRefreshBitbucketRepos(workspace);
  const repos = repoList.data ?? [];
  const q = repoSearch.toLowerCase();
  const filtered = q ? repos.filter((r) => r.name.toLowerCase().includes(q)) : repos;

  return (
    <>
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Workspace</Label>
        <Input
          placeholder="workspace slug"
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Repository</Label>
          {workspace.length >= 1 && (
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
              workspace.length < 1
                ? "Enter a workspace first"
                : repoList.isLoading
                  ? "Loading…"
                  : "Search repositories…"
            }
            disabled={disabled || workspace.length < 1}
          />
          <ComboboxContent>
            <ComboboxList>
              {repoList.isLoading && <ComboboxEmpty>Loading…</ComboboxEmpty>}
              {!repoList.isLoading && repos.length === 0 && (
                <ComboboxEmpty>No repositories found</ComboboxEmpty>
              )}
              {filtered.map((r) => (
                <ComboboxItem key={r.slug} value={r.name}>
                  <span className="font-medium">{r.name}</span>
                  {r.description && (
                    <span className="text-muted-foreground text-xs truncate ml-1">
                      {r.description}
                    </span>
                  )}
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>
    </>
  );
}

function BitbucketServerRepoForm({
  onRepoSelected,
  disabled,
}: {
  onRepoSelected: (url: string, name: string) => void;
  disabled?: boolean;
}) {
  const [selectedProject, setSelectedProject] = useState("");
  const [repoSearch, setRepoSearch] = useState("");

  const projectList = useListBitbucketProjects();
  const refreshProjects = useRefreshBitbucketProjects();
  const projects = projectList.data ?? [];

  const repoList = useListBitbucketRepos(selectedProject, selectedProject.length >= 1);
  const refreshRepos = useRefreshBitbucketRepos(selectedProject);
  const repos = repoList.data ?? [];
  const q = repoSearch.toLowerCase();
  const filtered = q ? repos.filter((r) => r.name.toLowerCase().includes(q)) : repos;

  return (
    <>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Project</Label>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground transition-colors"
            onClick={refreshProjects}
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
        <Combobox
          value={selectedProject}
          onValueChange={(v) => {
            setSelectedProject(v ?? "");
            setRepoSearch("");
          }}
          filter={null}
        >
          <ComboboxInput
            placeholder={projectList.isLoading ? "Loading…" : "Select a project…"}
            disabled={disabled}
          />
          <ComboboxContent>
            <ComboboxList>
              {projectList.isLoading && <ComboboxEmpty>Loading…</ComboboxEmpty>}
              {!projectList.isLoading && projects.length === 0 && (
                <ComboboxEmpty>No projects found</ComboboxEmpty>
              )}
              {projects.map((p) => (
                <ComboboxItem key={p.key} value={p.key}>
                  <span className="font-medium">{p.key}</span>
                  <span className="text-muted-foreground text-xs truncate ml-1">{p.name}</span>
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Repository</Label>
          {selectedProject.length >= 1 && (
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
              selectedProject.length < 1
                ? "Select a project first"
                : repoList.isLoading
                  ? "Loading…"
                  : "Search repositories…"
            }
            disabled={disabled || selectedProject.length < 1}
          />
          <ComboboxContent>
            <ComboboxList>
              {repoList.isLoading && <ComboboxEmpty>Loading…</ComboboxEmpty>}
              {!repoList.isLoading && repos.length === 0 && (
                <ComboboxEmpty>No repositories found</ComboboxEmpty>
              )}
              {filtered.map((r) => (
                <ComboboxItem key={r.slug} value={r.name}>
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
