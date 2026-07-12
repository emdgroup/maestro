import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Loader2 } from "lucide-react";
import { BrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { useSaveIntegration, PROVIDER_NAMES } from "@/services/integration.service";
import type { IntegrationStatus } from "@/services/integration.service";
import { getProviderFields } from "./integration-provider-config";

interface Props {
  integration: IntegrationStatus | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisconnect: (integration: IntegrationStatus) => void;
}

export function IntegrationDetailModal({ integration, open, onOpenChange, onDisconnect }: Props) {
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const [instanceUrl, setInstanceUrl] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { mutateAsync: saveIntegration, isPending } = useSaveIntegration();

  if (!integration) return null;

  const provider = integration.provider;
  const providerName = PROVIDER_NAMES[provider] ?? provider;
  const fields = getProviderFields(provider);

  const handleClose = () => {
    setEditing(false);
    setToken("");
    setInstanceUrl("");
    setEmail("");
    setError(null);
    onOpenChange(false);
  };

  const handleEditClick = () => {
    setInstanceUrl(integration.instance_url ?? "");
    setEmail(integration.display_name?.includes("@") ? integration.display_name : "");
    setToken("");
    setError(null);
    setEditing(true);
  };

  const handleSave = async () => {
    if (!token.trim()) {
      setError("Token is required");
      return;
    }
    setError(null);
    try {
      await saveIntegration({
        provider,
        token: token.trim(),
        instanceUrl: instanceUrl.trim() || null,
        email: email.trim() || null,
      });
      handleClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <BrandIcon slug={provider} className="w-6 h-6" />
            <DialogTitle>{providerName}</DialogTitle>
          </div>
        </DialogHeader>

        {!editing ? (
          // View mode
          <>
            <div className="space-y-3 py-2">
              {integration.display_name && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Account
                  </p>
                  <p className="text-sm font-mono bg-muted rounded px-2 py-1.5">
                    {integration.display_name}
                    {integration.source === "gh_cli" && (
                      <span className="ml-2 text-xs text-muted-foreground">gh cli</span>
                    )}
                  </p>
                </div>
              )}
              {integration.instance_url && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Instance URL
                  </p>
                  <p className="text-sm font-mono bg-muted rounded px-2 py-1.5 truncate">
                    {integration.instance_url}
                  </p>
                </div>
              )}
            </div>

            <DialogFooter className="flex-row justify-between sm:justify-between">
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={integration.source === "gh_cli"}
                title={integration.source === "gh_cli" ? "Managed by gh CLI" : undefined}
                onClick={() => onDisconnect(integration)}
              >
                Disconnect
              </Button>
              {integration.source !== "gh_cli" && (
                <Button onClick={handleEditClick}>Edit credentials</Button>
              )}
            </DialogFooter>
          </>
        ) : (
          // Edit mode — token always required
          <>
            <div className="space-y-4 py-2">
              {fields.showInstanceUrl && (
                <div className="space-y-2">
                  <Label htmlFor="detail-instance-url" required>
                    {fields.instanceUrlLabel}
                  </Label>
                  <Input
                    id="detail-instance-url"
                    placeholder={fields.instanceUrlPlaceholder}
                    value={instanceUrl}
                    onChange={(e) => setInstanceUrl(e.target.value)}
                    disabled={isPending}
                  />
                </div>
              )}

              {fields.showEmail && (
                <div className="space-y-2">
                  <Label htmlFor="detail-email" required>
                    Email
                  </Label>
                  <Input
                    id="detail-email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={isPending}
                  />
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="detail-token" required>
                  {fields.tokenLabel}
                </Label>
                <Input
                  id="detail-token"
                  type="password"
                  placeholder={`Required — enter new ${fields.tokenLabel.toLowerCase()}`}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={isPending}
                  aria-required="true"
                  aria-invalid={error && !token.trim() ? "true" : undefined}
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>

            <DialogFooter className="flex-row justify-between sm:justify-between">
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => onDisconnect(integration)}
                disabled={isPending}
              >
                Disconnect
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setEditing(false)} disabled={isPending}>
                  Cancel
                </Button>
                <Button onClick={handleSave} disabled={isPending || !token.trim()}>
                  {isPending ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Save"
                  )}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
