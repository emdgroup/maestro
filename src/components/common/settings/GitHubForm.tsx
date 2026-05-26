import { useState, useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SquareArrowOutUpRight, SearchAlert, RefreshCw, Loader2 } from "lucide-react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import type { IntegrationStatus } from "@/types/bindings";
import {
  useCheckGithubOwner,
  useListGithubRepos,
  useRefreshGithubRepos,
} from "@/services/issue-tracking-lookup.service";

interface Props {
  integration: IntegrationStatus;
  fields: Record<string, string>;
  onFieldsChange: (fields: Record<string, string>) => void;
}

function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

export function GitHubForm({ integration, fields, onFieldsChange }: Props) {
  const owner = fields.owner ?? "";
  const repo = fields.repo ?? "";
  const [byUrl, setByUrl] = useState("");
  const [repoSearch, setRepoSearch] = useState("");

  useEffect(() => {
    if (!fields.owner && integration.display_name) {
      onFieldsChange({ ...fields, owner: integration.display_name });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = repoSearch.toLowerCase();
  const ownerCheck = useCheckGithubOwner(owner);
  const ownerValid = ownerCheck.data === true;
  const ownerInvalid = ownerCheck.data === false;
  const repoList = useListGithubRepos(owner, ownerValid);
  const refreshRepos = useRefreshGithubRepos(owner);
  const repos = repoList.data ?? [];
  const visibleRepos = q ? repos.filter((r) => r.name.toLowerCase().includes(q)) : repos;

  function handleByUrlBlur() {
    const parsed = parseGitHubUrl(byUrl);
    if (parsed) {
      onFieldsChange({ ...fields, owner: parsed.owner, repo: parsed.repo });
      setByUrl("");
    }
  }

  function handleByUrlPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    const parsed = parseGitHubUrl(text);
    if (parsed) {
      e.preventDefault();
      onFieldsChange({ ...fields, owner: parsed.owner, repo: parsed.repo });
    }
  }

  return (
    <div className="space-y-3">
      {/* Owner */}
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Owner</Label>
        <div className="flex items-center gap-2">
          <Input
            className="flex-1"
            placeholder="username or org"
            value={owner}
            onChange={(e) => onFieldsChange({ ...fields, owner: e.target.value, repo: "" })}
          />
          {owner && ownerCheck.isLoading && (
            <Loader2 className="size-4 text-muted-foreground animate-spin shrink-0" />
          )}
          {owner && ownerValid && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0"
                    onClick={() => void openUrl(`https://github.com/${owner}`)}
                  />
                }
              >
                <SquareArrowOutUpRight className="size-4" />
              </TooltipTrigger>
              <TooltipContent>Open on GitHub</TooltipContent>
            </Tooltip>
          )}
          {owner && ownerInvalid && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label="User or organization not found"
                    className="shrink-0 text-destructive flex items-center"
                  />
                }
              >
                <SearchAlert className="size-4" />
              </TooltipTrigger>
              <TooltipContent>User or organization not found</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Repository */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Repository</Label>
          {ownerValid && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground transition-colors"
              onClick={refreshRepos}
              title="Refresh repositories"
            >
              <RefreshCw className="size-3.5" />
            </button>
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
              !ownerValid
                ? "Enter a valid owner first"
                : repoList.isLoading
                  ? "Loading repositories…"
                  : "Search repositories…"
            }
            disabled={!ownerValid}
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
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-muted-foreground">or</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* By URL */}
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">By URL</Label>
        <Input
          placeholder="https://github.com/owner/repository"
          value={byUrl}
          onChange={(e) => setByUrl(e.target.value)}
          onBlur={handleByUrlBlur}
          onPaste={handleByUrlPaste}
        />
        <p className="text-xs text-muted-foreground">
          Paste a GitHub URL to auto-fill owner and repository
        </p>
      </div>
    </div>
  );
}
