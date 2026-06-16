import { useState, useRef } from "react";
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
import { useSaveIntegration, PROVIDER_NAMES } from "@/services/integration.service";

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
    case "gitea":
      return {
        showInstanceUrl: true,
        instanceUrlLabel: "Instance URL",
        instanceUrlPlaceholder: "https://gitea.example.com",
        showEmail: false,
        tokenLabel: "Token",
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
        {
          text: "Sign in to dev.azure.com → click user settings, left of user avatar → Personal access tokens",
        },
        { text: "Click New Token → select your Organization" },
        { text: "Under Scopes, select Work Items (Read)" },
        { text: "Click Create and copy the token immediately" },
      ];
    case "gitea":
      return [
        { text: "Log into your Gitea instance" },
        { text: "Go to Settings → Applications → Manage Access Tokens" },
        { text: "Enter a token name, select issue scope (read)" },
        { text: "Click Generate Token and copy it immediately" },
      ];
    default:
      return null;
  }
}

const BITBUCKET_INSTRUCTIONS: Record<"cloud" | "server", InstructionLine[]> = {
  cloud: [
    { text: "Go to Bitbucket → Personal settings → App passwords" },
    { text: "Click Create app password → enter a label" },
    { text: "Select Repositories (Read) permissions" },
    { text: "Click Create — copy the password immediately" },
  ],
  server: [
    { text: "Log into your Bitbucket Server or Data Center instance" },
    { text: "Click your avatar → Manage account → HTTP access tokens" },
    { text: "Click Create token → enter a name, select Repositories (Read)" },
    { text: "Click Create — copy the token immediately" },
  ],
};

function ProviderInstructions({
  provider,
  bitbucketMode,
}: {
  provider: string;
  bitbucketMode?: "cloud" | "server";
}) {
  const [open, setOpen] = useState(false);

  const instructions =
    provider === "bitbucket" && bitbucketMode
      ? BITBUCKET_INSTRUCTIONS[bitbucketMode]
      : getProviderInstructions(provider);

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
                <li
                  key={i}
                  className="font-mono text-foreground bg-muted rounded px-1.5 py-0.5 list-none ml-4"
                >
                  {line.text}
                </li>
              ) : (
                <li key={i} className="leading-relaxed">
                  {line.text}
                </li>
              ),
            )}
          </ol>
        </div>
      )}
    </div>
  );
}

function BitbucketModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: "cloud" | "server";
  onChange: (m: "cloud" | "server") => void;
  disabled: boolean;
}) {
  return (
    <div className="flex rounded-md border border-border overflow-hidden w-fit">
      {(["cloud", "server"] as const).map((m) => (
        <button
          key={m}
          type="button"
          disabled={disabled}
          onClick={() => onChange(m)}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            mode === m
              ? "bg-primary text-primary-foreground"
              : "bg-background text-muted-foreground hover:bg-muted"
          }`}
        >
          {m === "cloud" ? "Cloud" : "Server / DC"}
        </button>
      ))}
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
  const [bitbucketMode, setBitbucketMode] = useState<"cloud" | "server">("cloud");
  const [attempted, setAttempted] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { mutateAsync: saveIntegration, isPending } = useSaveIntegration();

  const providerName = PROVIDER_NAMES[provider] ?? provider;
  const fields = getProviderFields(provider);
  const isBitbucket = provider === "bitbucket";

  const instanceUrlRequired = !isBitbucket && fields.showInstanceUrl;
  const emailRequired = !isBitbucket && fields.showEmail;
  const isSubmitDisabled =
    isPending ||
    !token.trim() ||
    (instanceUrlRequired && !instanceUrl.trim()) ||
    (emailRequired && !email.trim());

  const triggerValidation = () => {
    const el = formRef.current;
    if (el) {
      el.classList.remove("animate-shake");
      void el.offsetWidth;
      el.classList.add("animate-shake");
    }
    setAttempted(true);
    if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => setAttempted(false), 2000);
  };

  const startHoverTimer = () => {
    if (!isSubmitDisabled) return;
    hoverTimerRef.current = setTimeout(triggerValidation, 500);
  };

  const cancelHoverTimer = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setToken("");
      setInstanceUrl("");
      setEmail("");
      setError(null);
      setBitbucketMode("cloud");
      setAttempted(false);
      cancelHoverTimer();
      if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
    }
    onOpenChange(nextOpen);
  };

  const handleModeChange = (m: "cloud" | "server") => {
    setBitbucketMode(m);
    setToken("");
    setInstanceUrl("");
    setEmail("");
    setError(null);
    setAttempted(false);
  };

  const handleSubmit = async () => {
    if (isSubmitDisabled) return;
    setError(null);
    try {
      await saveIntegration({
        provider,
        token: token.trim(),
        instanceUrl: isBitbucket
          ? bitbucketMode === "server"
            ? instanceUrl.trim() || null
            : null
          : instanceUrl.trim() || null,
        email: isBitbucket
          ? bitbucketMode === "cloud"
            ? email.trim() || null
            : null
          : email.trim() || null,
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
          <DialogDescription>Enter your credentials to connect {providerName}.</DialogDescription>
        </DialogHeader>

        <div ref={formRef} className="space-y-4 py-2">
          {isBitbucket && (
            <BitbucketModeToggle
              mode={bitbucketMode}
              onChange={handleModeChange}
              disabled={isPending}
            />
          )}

          {isBitbucket ? (
            <>
              {bitbucketMode === "server" && (
                <div className="space-y-2">
                  <Label htmlFor="integration-instance-url">Instance URL</Label>
                  <Input
                    id="integration-instance-url"
                    placeholder="https://bitbucket.mycompany.com"
                    value={instanceUrl}
                    onChange={(e) => setInstanceUrl(e.target.value)}
                    disabled={isPending}
                  />
                </div>
              )}
              {bitbucketMode === "cloud" && (
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
                <Label htmlFor="integration-token" required>
                  {bitbucketMode === "cloud" ? "App Password" : "HTTP Access Token"}
                </Label>
                <Input
                  id="integration-token"
                  type="password"
                  placeholder={
                    bitbucketMode === "cloud" ? "Enter app password" : "Enter HTTP access token"
                  }
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={isPending}
                  aria-required="true"
                  aria-invalid={attempted && !token.trim() ? "true" : undefined}
                />
                {attempted && !token.trim() && (
                  <p className="text-xs text-destructive">
                    {bitbucketMode === "cloud" ? "App password" : "Access token"} is required
                  </p>
                )}
              </div>
            </>
          ) : (
            <>
              {fields.showInstanceUrl && (
                <div className="space-y-2">
                  <Label htmlFor="integration-instance-url" required>
                    {fields.instanceUrlLabel}
                  </Label>
                  <Input
                    id="integration-instance-url"
                    placeholder={fields.instanceUrlPlaceholder}
                    value={instanceUrl}
                    onChange={(e) => setInstanceUrl(e.target.value)}
                    disabled={isPending}
                    aria-required="true"
                    aria-invalid={attempted && !instanceUrl.trim() ? "true" : undefined}
                  />
                  {attempted && !instanceUrl.trim() && (
                    <p className="text-xs text-destructive">
                      {fields.instanceUrlLabel} is required
                    </p>
                  )}
                </div>
              )}

              {fields.showEmail && (
                <div className="space-y-2">
                  <Label htmlFor="integration-email" required>
                    Email
                  </Label>
                  <Input
                    id="integration-email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={isPending}
                    aria-required="true"
                    aria-invalid={attempted && !email.trim() ? "true" : undefined}
                  />
                  {attempted && !email.trim() && (
                    <p className="text-xs text-destructive">Email is required</p>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="integration-token" required>
                  {fields.tokenLabel}
                </Label>
                <Input
                  id="integration-token"
                  type="password"
                  placeholder={`Enter ${fields.tokenLabel.toLowerCase()}`}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={isPending}
                  aria-required="true"
                  aria-invalid={attempted && !token.trim() ? "true" : undefined}
                />
                {attempted && !token.trim() && (
                  <p className="text-xs text-destructive">{fields.tokenLabel} is required</p>
                )}
              </div>
            </>
          )}

          <ProviderInstructions
            provider={provider}
            bitbucketMode={isBitbucket ? bitbucketMode : undefined}
          />

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <div onMouseEnter={startHoverTimer} onMouseLeave={cancelHoverTimer}>
            <Button onClick={handleSubmit} disabled={isSubmitDisabled}>
              {isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Connecting...
                </>
              ) : (
                "Connect"
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
