import { useState, type ReactNode } from "react";
import { Check, Copy, Eye, EyeOff, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils";
import { relativeAge } from "@/components/execution/worktree-card/worktree-usage";
import {
  useAutomationsQuery,
  useRollWebhookSecretMutation,
  useWebhookDeliveriesQuery,
  useWebhookSettingsQuery,
} from "@/services/automation.service";
import { useNow } from "@/hooks/useNow";
import { webhookUrl } from "./webhook-url";
import type { Automation, ConnectionKey, DeliveryOutcome, WebhookOverlap } from "@/types/bindings";

const OVERLAP: Record<WebhookOverlap, { label: string; description: string }> = {
  refuse: {
    label: "Refuse it",
    description: "The sender gets 409 Conflict and nothing runs.",
  },
  queue: {
    label: "Queue it",
    description: "Up to 10 wait in order and run one after another.",
  },
  parallel: {
    label: "Run it alongside",
    description: "Another run starts at once, beside the one going.",
  },
};

const OUTCOME: Record<DeliveryOutcome, { label: string; tone: string }> = {
  started: { label: "Started a run", tone: "text-emerald-600" },
  queued: { label: "Queued", tone: "text-muted-foreground" },
  busy: { label: "Refused: a run was going", tone: "text-amber-600" },
  queue_full: { label: "Refused: queue full", tone: "text-amber-600" },
  rate_limited: { label: "Refused: too many", tone: "text-amber-600" },
  unauthorized: { label: "Wrong or missing secret", tone: "text-destructive" },
  duplicate: { label: "Ignored: already received", tone: "text-muted-foreground" },
  disabled: { label: "Refused: switched off", tone: "text-amber-600" },
  too_large: { label: "Refused: body over 1 MB", tone: "text-destructive" },
  failed: { label: "Could not start", tone: "text-destructive" },
};

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            className="size-6 shrink-0 text-muted-foreground"
            onClick={() => {
              void navigator.clipboard.writeText(value).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1_500);
              });
            }}
          />
        }
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** A secret, hidden until asked for, with a way to copy it whether shown or not. */
function SecretField({ secret, children }: { secret: string; children?: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1">
      <code className="min-w-0 flex-1 truncate text-[11px]">
        {revealed ? secret : "•".repeat(secret.length)}
      </code>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={revealed ? "Hide the secret" : "Show the secret"}
              className="size-6 shrink-0 text-muted-foreground"
              onClick={() => setRevealed(!revealed)}
            />
          }
        >
          {revealed ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
        </TooltipTrigger>
        <TooltipContent>{revealed ? "Hide" : "Show"}</TooltipContent>
      </Tooltip>
      <CopyButton value={secret} label="Copy the secret" />
      {children}
    </div>
  );
}

/**
 * The webhook trigger: a URL that starts this automation when something calls it.
 *
 * What a user comes here for is either setting a sender up, which is the URL, the secret and an
 * example, or finding out why one does nothing, which is the list of what arrived.
 */
export function WebhookSection({
  projectId,
  connection,
  automation,
  saved,
  onChange,
}: {
  projectId: number;
  connection: ConnectionKey;
  automation: Automation;
  /** Whether this automation exists on the server yet. Its secret is made there, on save. */
  saved: boolean;
  onChange: (fields: Partial<Automation>) => void;
}) {
  const { data: status } = useWebhookSettingsQuery(connection);
  // Read from the list rather than the draft: a rolled secret arrives there, and the draft is a
  // copy taken when the dialog opened.
  const { data: list } = useAutomationsQuery(projectId);
  const secret = list?.automations.find((stored) => stored.id === automation.id)?.webhook_secret;
  const roll = useRollWebhookSecretMutation();
  const { data: deliveries } = useWebhookDeliveriesQuery(
    projectId,
    saved && automation.webhook_enabled ? automation.id : null,
  );
  const now = useNow();

  const url = status ? webhookUrl(status, automation.id) : null;
  const sharedDirectory =
    automation.webhook_overlap === "parallel" && automation.workspace.mode !== "new_worktree";

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      {url && (
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">URL</span>
          <div className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1">
            <code className="min-w-0 flex-1 truncate text-[11px]">{url}</code>
            <CopyButton value={url} label="Copy the URL" />
          </div>
          {status?.error ? (
            <p className="text-[11px] text-destructive">{status.error}</p>
          ) : (
            !status?.settings.public_url && (
              <p className="text-[11px] text-muted-foreground/70">
                Only reachable from this machine. For a service on the internet, put a tunnel or
                reverse proxy in front and set its address under Settings, Webhooks.
              </p>
            )
          )}
        </div>
      )}

      <div className="space-y-1">
        <span className="text-[11px] text-muted-foreground">Secret</span>
        {secret ? (
          <SecretField secret={secret}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Replace the secret"
                    disabled={roll.isPending}
                    className="size-6 shrink-0 text-muted-foreground"
                    onClick={() => roll.mutate({ projectId, automationId: automation.id })}
                  />
                }
              >
                <RefreshCw className="size-3" />
              </TooltipTrigger>
              <TooltipContent>
                Replace it. Senders using the current one stop working at once.
              </TooltipContent>
            </Tooltip>
          </SecretField>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Made when you save, and shown to you then.
          </p>
        )}
        <p className="text-[11px] leading-relaxed text-muted-foreground/70">
          A sender signs the body with it as GitHub does (<code>X-Hub-Signature-256</code>), or
          sends it as <code>Authorization: Bearer &lt;secret&gt;</code>. The request body is added
          below the prompt for the agent to read.
        </p>
      </div>

      <div className="space-y-1">
        <span className="text-[11px] text-muted-foreground">If a run is already going</span>
        <Select
          value={automation.webhook_overlap}
          onValueChange={(value) => value && onChange({ webhook_overlap: value as WebhookOverlap })}
        >
          <SelectTrigger size="sm" className="w-full text-xs" aria-label="If a run is going">
            <span className="flex-1 truncate text-left">
              {OVERLAP[automation.webhook_overlap].label}
            </span>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(OVERLAP) as WebhookOverlap[]).map((overlap) => (
              <SelectItem key={overlap} value={overlap} className="text-xs">
                <div>
                  <div>{OVERLAP[overlap].label}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {OVERLAP[overlap].description}
                  </div>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {sharedDirectory && (
          <p className="flex items-start gap-1 text-[11px] text-amber-600">
            <TriangleAlert className="mt-px size-3 shrink-0" />
            This automation does not get its own worktree per run, so runs alongside each other work
            in the same directory and can undo each other's changes.
          </p>
        )}
      </div>

      {saved && (
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Last deliveries</span>
          {deliveries && deliveries.length > 0 ? (
            <div className="divide-y divide-border/60 rounded-md border border-border bg-background">
              {deliveries.map((delivery) => (
                <div key={delivery.id} className="flex items-center gap-2 px-2 py-1 text-[11px]">
                  <span className="w-16 shrink-0 text-muted-foreground">
                    {relativeAge(delivery.received_at, now)} ago
                  </span>
                  <span className="w-8 shrink-0 font-mono text-muted-foreground">
                    {delivery.status}
                  </span>
                  <span className={cn("shrink-0", OUTCOME[delivery.outcome].tone)}>
                    {OUTCOME[delivery.outcome].label}
                  </span>
                  {delivery.detail && (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {delivery.detail}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground/70">Nothing has arrived yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The URL and secret of a webhook that has just been turned on, shown once on save.
 *
 * The secret is made by the server on that save, so the editor that asked for it never had it.
 * This is where a sender gets set up; the editor shows both again whenever it is reopened.
 */
export function WebhookCreatedDialog({
  automation,
  connection,
  onClose,
}: {
  /** The automation as saved, carrying its new secret, or `null` when nothing is shown. */
  automation: Automation | null;
  connection: ConnectionKey;
  onClose: () => void;
}) {
  const { data: status } = useWebhookSettingsQuery(automation ? connection : null);
  const url = status && automation ? webhookUrl(status, automation.id) : null;
  const secret = automation?.webhook_secret;

  return (
    <Dialog open={automation !== null} onOpenChange={(open) => !open && onClose()}>
      {automation && (
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Webhook ready</DialogTitle>
            <DialogDescription>
              Give these to the service that should start “{automation.name}”.
            </DialogDescription>
          </DialogHeader>
          {/* min-w-0: the dialog is a grid, and a grid item will not shrink below a long secret. */}
          <div className="min-w-0 space-y-3">
            {url && (
              <div className="space-y-1">
                <span className="text-[11px] text-muted-foreground">URL</span>
                <div className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1">
                  <code className="min-w-0 flex-1 truncate text-[11px]">{url}</code>
                  <CopyButton value={url} label="Copy the URL" />
                </div>
              </div>
            )}
            {secret && (
              <div className="space-y-1">
                <span className="text-[11px] text-muted-foreground">Secret</span>
                <SecretField secret={secret} />
              </div>
            )}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Sign the body with the secret as GitHub does (<code>X-Hub-Signature-256</code>), or
              send it as <code>Authorization: Bearer &lt;secret&gt;</code>. Both stay available in
              the automation&apos;s editor.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
