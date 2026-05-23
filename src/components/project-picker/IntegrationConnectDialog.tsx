import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { useSaveIntegration } from "@/services/integration.service";

const PROVIDER_NAMES: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  forgejo: "Forgejo",
  linear: "Linear",
  jira_cloud: "Jira Cloud",
  azuredevops: "Azure DevOps",
};

interface IntegrationConnectDialogProps {
  provider: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function getProviderFields(provider: string): {
  showInstanceUrl: boolean;
  instanceUrlLabel: string;
  instanceUrlPlaceholder: string;
  showEmail: boolean;
  tokenLabel: string;
} {
  switch (provider) {
    case "gitlab":
      return {
        showInstanceUrl: true,
        instanceUrlLabel: "Instance URL",
        instanceUrlPlaceholder: "https://gitlab.com",
        showEmail: false,
        tokenLabel: "Token",
      };
    case "forgejo":
      return {
        showInstanceUrl: true,
        instanceUrlLabel: "Instance URL",
        instanceUrlPlaceholder: "https://codeberg.org",
        showEmail: false,
        tokenLabel: "Token",
      };
    case "jira_cloud":
      return {
        showInstanceUrl: true,
        instanceUrlLabel: "Site URL",
        instanceUrlPlaceholder: "https://yourorg.atlassian.net",
        showEmail: true,
        tokenLabel: "API Token",
      };
    case "azuredevops":
      return {
        showInstanceUrl: true,
        instanceUrlLabel: "Organization URL",
        instanceUrlPlaceholder: "https://dev.azure.com/yourorg",
        showEmail: false,
        tokenLabel: "Personal Access Token",
      };
    case "linear":
      return {
        showInstanceUrl: false,
        instanceUrlLabel: "",
        instanceUrlPlaceholder: "",
        showEmail: false,
        tokenLabel: "API Key",
      };
    default:
      return {
        showInstanceUrl: false,
        instanceUrlLabel: "",
        instanceUrlPlaceholder: "",
        showEmail: false,
        tokenLabel: "Token",
      };
  }
}

interface InstructionLine {
  text: string;
  code?: boolean;
}

function getProviderInstructions(provider: string): InstructionLine[] | null {
  switch (provider) {
    case "github":
      return [
        { text: "Open GitHub → Settings → Developer settings → Personal access tokens" },
        { text: "Click Generate new token (classic) → add a note" },
        { text: "Select scopes: repo, read:user" },
        { text: "Click Generate token and copy it immediately" },
        { text: "Tip: if gh CLI is authenticated, Maestro will auto-detect your token." },
      ];
    case "gitlab":
      return [
        { text: "Open GitLab → click your avatar → Edit profile → Access Tokens" },
        { text: "Enter a name, optional expiry, and select scopes:", code: false },
        { text: "read_api, read_user, read_repository", code: true },
        { text: "Click Create personal access token and copy it immediately" },
      ];
    case "forgejo":
      return [
        { text: "Log into your Forgejo instance" },
        { text: "Go to Settings → Applications → Manage Access Tokens" },
        { text: "Enter a token name, select issue scope (read)" },
        { text: "Click Generate Token and copy it immediately" },
      ];
    case "linear":
      return [
        { text: "Open Linear → Settings → API → Personal API Keys" },
        { text: "Click Create key → enter a label" },
        { text: "Copy the key immediately — it won't be shown again" },
      ];
    case "jira_cloud":
      return [
        { text: "Go to: https://id.atlassian.com/manage-profile/security/api-tokens", code: true },
        { text: "Click Create API token → enter a label → Create" },
        { text: "Copy the token immediately — it won't be shown again" },
        { text: "Site URL: your *.atlassian.net domain (e.g. yourorg.atlassian.net)" },
        { text: "Email: your Atlassian account email address" },
      ];
    case "azuredevops":
      return [
        { text: "Sign in to dev.azure.com → click your avatar → Personal access tokens" },
        { text: "Click New Token → select your Organization" },
        { text: "Under Scopes, select Work Items (Read)" },
        { text: "Click Create and copy the token immediately" },
        { text: "Organization URL format: https://dev.azure.com/yourorgname", code: true },
      ];
    default:
      return null;
  }
}

function ProviderInstructions({ provider }: { provider: string }) {
  const [open, setOpen] = useState(false);
  const instructions = getProviderInstructions(provider);
  if (!instructions) return null;

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        Instructions to get token
      </button>
      {open && (
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <ol className="space-y-1.5 text-xs text-muted-foreground list-decimal list-inside">
            {instructions.map((line, i) =>
              line.code ? (
                <li key={i} className="font-mono text-foreground bg-muted rounded px-1.5 py-0.5 list-none ml-4">
                  {line.text}
                </li>
              ) : (
                <li key={i} className="leading-relaxed">{line.text}</li>
              ),
            )}
          </ol>
        </div>
      )}
    </div>
  );
}

export function IntegrationConnectDialog({
  provider,
  open,
  onOpenChange,
}: IntegrationConnectDialogProps) {
  const [token, setToken] = useState("");
  const [instanceUrl, setInstanceUrl] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { mutateAsync: saveIntegration, isPending } = useSaveIntegration();

  const providerName = PROVIDER_NAMES[provider] ?? provider;
  const fields = getProviderFields(provider);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setToken("");
      setInstanceUrl("");
      setEmail("");
      setError(null);
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async () => {
    if (!token.trim()) return;
    setError(null);
    try {
      await saveIntegration({
        provider,
        token: token.trim(),
        instanceUrl: instanceUrl.trim() || null,
        email: email.trim() || null,
      });
      handleOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect {providerName}</DialogTitle>
          <DialogDescription>
            Enter your credentials to connect {providerName}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {fields.showInstanceUrl && (
            <div className="space-y-2">
              <Label htmlFor="integration-instance-url">{fields.instanceUrlLabel}</Label>
              <Input
                id="integration-instance-url"
                placeholder={fields.instanceUrlPlaceholder}
                value={instanceUrl}
                onChange={(e) => setInstanceUrl(e.target.value)}
                disabled={isPending}
              />
            </div>
          )}

          {fields.showEmail && (
            <div className="space-y-2">
              <Label htmlFor="integration-email">Email</Label>
              <Input
                id="integration-email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isPending}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="integration-token">{fields.tokenLabel}</Label>
            <Input
              id="integration-token"
              type="password"
              placeholder={`Enter ${fields.tokenLabel.toLowerCase()}`}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={isPending}
            />
          </div>

          <ProviderInstructions provider={provider} />

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending || !token.trim()}>
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Connecting...
              </>
            ) : (
              "Connect"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
