import { useState, useMemo } from "react";
import { X, RefreshCw, Loader2 } from "lucide-react";
import { Label } from "@/ui/label";
import { Input } from "@/ui/input";
import { Button } from "@/ui/button";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "@/ui/combobox";
import { BrandIcon } from "@/components/common/BrandIcon";
import {
  useListIntegrations,
  PROVIDER_NAMES,
  PROVIDER_CAPABILITIES,
} from "@/services/integration.service";
import {
  useCheckGithubOwner,
  useListGithubRepos,
  useRefreshGithubRepos,
  useListGitlabProjects,
  useListForgejoRepos,
  useRefreshForgejoRepos,
  useListGiteaRepos,
  useRefreshGiteaRepos,
  useListAzureDevOpsProjects,
  useListAzureDevOpsRepos,
  useRefreshAzureDevOpsRepos,
  useListBitbucketRepos,
  useRefreshBitbucketRepos,
  useListBitbucketProjects,
  useRefreshBitbucketProjects,
} from "@/services/integration-lookup.service";

interface ProviderRepoPickerProps {
  onRepoSelected: (cloneUrl: string, repoName: string, provider?: string) => void;
  disabled?: boolean;
}

export function ProviderRepoPicker({ onRepoSelected, disabled }: ProviderRepoPickerProps) {
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const integrationsQuery = useListIntegrations();

  const repoProviders = useMemo(() => {
    if (!integrationsQuery.data) return [];
    return integrationsQuery.data.filter(
      (i) => i.connected && PROVIDER_CAPABILITIES[i.provider]?.includes("repos"),
    );
  }, [integrationsQuery.data]);

  if (integrationsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
        <Loader2 className="size-4 mr-2 animate-spin" />
        Loading providers…
      </div>
    );
  }

  if (repoProviders.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm leading-relaxed">
        No repo providers connected.
        <br />
        <span className="text-xs">
          Connect GitHub, GitLab or others in{" "}
          <strong className="text-foreground">Integrations</strong>.
        </span>
      </div>
    );
  }

  if (!selectedProvider) {
    return (
      <div className="flex flex-wrap gap-2">
        {repoProviders.map((provider) => (
          <button
            key={provider.provider}
            type="button"
            disabled={disabled}
            onClick={() => setSelectedProvider(provider.provider)}
            className="flex flex-1 min-w-[120px] items-center gap-2.5 rounded-lg border border-border bg-muted px-3 py-2.5 text-sm font-medium text-foreground hover:border-accent hover:bg-accent/5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <BrandIcon slug={provider.provider} width={18} height={18} />
            <span className="flex-1 text-left">{PROVIDER_NAMES[provider.provider]}</span>
            <span className="size-1.5 rounded-full bg-success shrink-0" />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Selected provider card + X */}
      <div className="flex items-center gap-2">
        <div className="flex flex-1 items-center gap-2.5 rounded-lg border border-accent bg-accent/10 px-3 py-2">
          <BrandIcon slug={selectedProvider} width={18} height={18} />
          <span className="text-sm font-medium">{PROVIDER_NAMES[selectedProvider]}</span>
          <span className="size-1.5 rounded-full bg-success shrink-0" />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => setSelectedProvider(null)}
          aria-label="Change provider"
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {/* Provider-specific form */}
      <ProviderForm
        provider={selectedProvider}
        integration={repoProviders.find((p) => p.provider === selectedProvider) ?? null}
        onRepoSelected={onRepoSelected}
        disabled={disabled}
      />
    </div>
  );
}

interface ProviderFormProps {
  provider: string;
  integration: { display_name?: string | null; instance_url?: string | null } | null;
  onRepoSelected: (cloneUrl: string, repoName: string, provider?: string) => void;
  disabled?: boolean;
}

function ProviderForm({ provider, integration, onRepoSelected, disabled }: ProviderFormProps) {
  const withProvider = (url: string, name: string) => onRepoSelected(url, name, provider);

  switch (provider) {
    case "github":
      return (
        <GitHubRepoForm
          defaultOwner={integration?.display_name ?? undefined}
          onRepoSelected={withProvider}
          disabled={disabled}
        />
      );
    case "gitlab":
      return <GitLabRepoForm onRepoSelected={withProvider} disabled={disabled} />;
    case "forgejo":
      return (
        <OwnerRepoForm
          provider="forgejo"
          onRepoSelected={withProvider}
          disabled={disabled}
        />
      );
    case "gitea":
      return (
        <OwnerRepoForm provider="gitea" onRepoSelected={withProvider} disabled={disabled} />
      );
    case "azuredevops":
      return <AzureDevOpsRepoForm onRepoSelected={withProvider} disabled={disabled} />;
    case "bitbucket":
      return (
        <BitbucketRepoForm
          instanceUrl={integration?.instance_url ?? null}
          onRepoSelected={withProvider}
          disabled={disabled}
        />
      );
    default:
      return null;
  }
}

// ── GitHub ──────────────────────────────────────────────────────────────────

function GitHubRepoForm({
  defaultOwner,
  onRepoSelected,
  disabled,
}: {
  defaultOwner?: string;
  onRepoSelected: (url: string, name: string) => void;
  disabled?: boolean;
}) {
  const [owner, setOwner] = useState(defaultOwner ?? "");
  const [repoSearch, setRepoSearch] = useState("");

  const ownerCheck = useCheckGithubOwner(owner);
  const ownerValid = ownerCheck.data === true;
  const repoList = useListGithubRepos(owner, ownerValid);
  const refreshRepos = useRefreshGithubRepos(owner);
  const repos = repoList.data ?? [];
  const q = repoSearch.toLowerCase();
  const filtered = q ? repos.filter((r) => r.name.toLowerCase().includes(q)) : repos;

  return (
    <>
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Owner</Label>
        <Input
          placeholder="username or org"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Repository</Label>
          {ownerValid && (
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
            const cloneUrl = repo?.clone_url ?? `https://github.com/${owner}/${v}.git`;
            onRepoSelected(cloneUrl, v);
          }}
          onInputValueChange={(v) => setRepoSearch(v)}
          filter={null}
        >
          <ComboboxInput
            placeholder={
              !ownerValid
                ? "Enter a valid owner first"
                : repoList.isLoading
                  ? "Loading…"
                  : "Search repositories…"
            }
            disabled={disabled || !ownerValid}
          />
          <ComboboxContent>
            <ComboboxList>
              {repoList.isLoading && <ComboboxEmpty>Loading…</ComboboxEmpty>}
              {!repoList.isLoading && repos.length === 0 && (
                <ComboboxEmpty>No repositories found</ComboboxEmpty>
              )}
              {filtered.map((r) => (
                <ComboboxItem key={r.name} value={r.name}>
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

// ── GitLab ──────────────────────────────────────────────────────────────────

function GitLabRepoForm({
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

// ── Forgejo / Gitea (shared owner+repo pattern) ─────────────────────────────

function OwnerRepoForm({
  provider,
  onRepoSelected,
  disabled,
}: {
  provider: "forgejo" | "gitea";
  onRepoSelected: (url: string, name: string) => void;
  disabled?: boolean;
}) {
  const [owner, setOwner] = useState("");
  const [repoSearch, setRepoSearch] = useState("");

  const useRepos = provider === "forgejo" ? useListForgejoRepos : useListGiteaRepos;
  const useRefresh = provider === "forgejo" ? useRefreshForgejoRepos : useRefreshGiteaRepos;

  const repoList = useRepos(owner, owner.length >= 1);
  const refreshRepos = useRefresh(owner);
  const repos = repoList.data ?? [];
  const q = repoSearch.toLowerCase();
  const filtered = q ? repos.filter((r) => r.name.toLowerCase().includes(q)) : repos;

  return (
    <>
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Owner</Label>
        <Input
          placeholder="username or org"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Repository</Label>
          {owner.length >= 1 && (
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
              owner.length < 1
                ? "Enter an owner first"
                : repoList.isLoading
                  ? "Loading…"
                  : "Search repositories…"
            }
            disabled={disabled || owner.length < 1}
          />
          <ComboboxContent>
            <ComboboxList>
              {repoList.isLoading && <ComboboxEmpty>Loading…</ComboboxEmpty>}
              {!repoList.isLoading && repos.length === 0 && (
                <ComboboxEmpty>No repositories found</ComboboxEmpty>
              )}
              {filtered.map((r) => (
                <ComboboxItem key={r.name} value={r.name}>
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

// ── Azure DevOps (project → repo two-step) ──────────────────────────────────

function AzureDevOpsRepoForm({
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

// ── Bitbucket (workspace + repo) ────────────────────────────────────────────

function BitbucketRepoForm({
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
