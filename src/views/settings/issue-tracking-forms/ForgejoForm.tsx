import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Label } from "@/ui/label";
import { Input } from "@/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "@/ui/combobox";
import type { IntegrationStatus, RepoOption } from "@/types/bindings";
import {
  useListForgejoRepos,
  useRefreshForgejoRepos,
  useListGiteaRepos,
  useRefreshGiteaRepos,
} from "@/services/integration-lookup.service";

interface Props {
  integration: IntegrationStatus;
  fields: Record<string, string>;
  onFieldsChange: (fields: Record<string, string>) => void;
  showValidation?: boolean;
}

function RepoProviderForm({
  integration,
  fields,
  onFieldsChange,
  repoList,
  refreshRepos,
  showValidation,
}: Props & {
  repoList: { data?: RepoOption[]; isLoading: boolean };
  refreshRepos: () => void;
}) {
  const owner = fields.owner ?? "";
  const repo = fields.repo ?? "";
  const ownerSet = owner.length >= 1;
  const [repoSearch, setRepoSearch] = useState("");

  useEffect(() => {
    if (!fields.owner && integration.display_name) {
      onFieldsChange({ ...fields, owner: integration.display_name });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = repoSearch.toLowerCase();
  const repos = repoList.data ?? [];
  const visibleRepos = q ? repos.filter((r) => r.name.toLowerCase().includes(q)) : repos;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-sm font-medium" required>
          Owner
        </Label>
        <Input
          placeholder="username or org"
          value={owner}
          onChange={(e) => onFieldsChange({ ...fields, owner: e.target.value, repo: "" })}
          aria-required="true"
          aria-invalid={showValidation && !owner ? "true" : undefined}
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium" required>
            Repository
          </Label>
          {ownerSet && (
            <Tooltip>
              <TooltipTrigger
                type="button"
                className="text-muted-foreground hover:text-foreground transition-colors"
                onClick={refreshRepos}
              >
                <RefreshCw className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Refresh repositories</TooltipContent>
            </Tooltip>
          )}
        </div>
        <Combobox
          value={repo}
          onValueChange={(v) => onFieldsChange({ ...fields, repo: v ?? "" })}
          onInputValueChange={(v) => setRepoSearch(v)}
          filter={null}
        >
          <ComboboxInput
            placeholder={
              !ownerSet
                ? "Enter an owner first"
                : repoList.isLoading
                  ? "Loading repositories…"
                  : "Search repositories…"
            }
            disabled={!ownerSet}
            showClear={!!repo}
          />
          <ComboboxContent>
            <ComboboxList>
              {repoList.isLoading && <ComboboxEmpty>Loading…</ComboboxEmpty>}
              {!repoList.isLoading && repos.length === 0 && (
                <ComboboxEmpty>No repositories found</ComboboxEmpty>
              )}
              {visibleRepos.map((r) => (
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
        {showValidation && !repo && (
          <p className="text-xs text-destructive mt-1">Repository is required</p>
        )}
      </div>
    </div>
  );
}

export function ForgejoForm({ integration, fields, onFieldsChange, showValidation }: Props) {
  const owner = fields.owner ?? "";
  const repoList = useListForgejoRepos(owner, owner.length >= 1);
  const refreshRepos = useRefreshForgejoRepos(owner);
  return (
    <RepoProviderForm
      integration={integration}
      fields={fields}
      onFieldsChange={onFieldsChange}
      repoList={repoList}
      refreshRepos={refreshRepos}
      showValidation={showValidation}
    />
  );
}

export function GiteaForm({ integration, fields, onFieldsChange, showValidation }: Props) {
  const owner = fields.owner ?? "";
  const repoList = useListGiteaRepos(owner, owner.length >= 1);
  const refreshRepos = useRefreshGiteaRepos(owner);
  return (
    <RepoProviderForm
      integration={integration}
      fields={fields}
      onFieldsChange={onFieldsChange}
      repoList={repoList}
      refreshRepos={refreshRepos}
      showValidation={showValidation}
    />
  );
}
