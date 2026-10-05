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
  useListForgejoRepos,
  useRefreshForgejoRepos,
  useListGiteaRepos,
  useRefreshGiteaRepos,
} from "@/services/integration-lookup.service";

export function OwnerRepoForm({
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
