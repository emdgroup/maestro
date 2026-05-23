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
import { Loader2 } from "lucide-react";
import { useSaveIntegration } from "@/services/integration.service";

const PROVIDER_NAMES: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  forgejo: "Forgejo",
  linear: "Linear",
  jira_cloud: "Jira Cloud",
  jira_server: "Jira Server",
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
    case "jira_server":
      return {
        showInstanceUrl: true,
        instanceUrlLabel: "Base URL",
        instanceUrlPlaceholder: "https://jira.yourcompany.com",
        showEmail: false,
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
