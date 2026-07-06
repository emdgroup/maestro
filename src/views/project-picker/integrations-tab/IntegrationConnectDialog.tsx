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
import { Loader2 } from "lucide-react";
import { useSaveIntegration, PROVIDER_NAMES } from "@/services/integration.service";
import { getProviderFields } from "./integration-provider-config";
import { ProviderInstructions } from "./ProviderInstructions";

interface IntegrationConnectDialogProps {
  provider: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
