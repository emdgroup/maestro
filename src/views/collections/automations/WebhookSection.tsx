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
import {
  useAutomationsQuery,
  useRollWebhookSecretMutation,
  useWebhookSettingsQuery,
} from "@/services/automation.service";
import { webhookUrl } from "./webhook-url";
import type { Automation, ConnectionKey, WebhookOverlap } from "@/types/bindings";

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
      {/* One line that scrolls rather than one cut short: a secret ending in "…" reads as one that
          was not all copied. At this size it fits both dialogs; in a narrow window it scrolls, with no bar. */}
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap scrollbar-none text-[11px]">
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
 * What a user comes here for is setting a sender up: the URL and the secret. Why one did nothing
 * is in the automation's own history, beside its runs.
 */
export function WebhookSection({
  projectId,
  connection,
  automation,
  saved,
  template = false,
  onChange,
}: {
  projectId: number;
  connection: ConnectionKey;
  automation: Automation;
  /** Whether this automation exists on the server yet. Its secret is made there, on save. */
  saved: boolean;
  /** A template's trigger, which never has a URL or a secret of its own. */
  template?: boolean;
  onChange: (fields: Partial<Automation>) => void;
}) {
  const { data: status } = useWebhookSettingsQuery(connection);
  // Read from the list rather than the draft: a rolled secret arrives there, and the draft is a
  // copy taken when the dialog opened.
  const { data: list } = useAutomationsQuery(projectId);
  const secret = list?.automations.find((stored) => stored.id === automation.id)?.webhook_secret;
  const roll = useRollWebhookSecretMutation();

  const url = status ? webhookUrl(status, automation.id) : null;
  const sharedDirectory =
    automation.webhook_overlap === "parallel" && automation.workspace.mode !== "new_worktree";

  const overlap = (
    <div className="space-y-1">
      <span className="text-[11px] text-muted-foreground">
        If a request is received while a run is already going
      </span>
      <Select
        value={automation.webhook_overlap}
        onValueChange={(value) => value && onChange({ webhook_overlap: value as WebhookOverlap })}
      >
        <SelectTrigger
          size="sm"
          className="w-full text-xs"
          aria-label="If a request is received while a run is already going"
        >
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
  );

  // No secret yet: the server makes it on save, and the URL is shown with it then, in its own
  // dialog. Until there is something to copy, the only choice to make here is the overlap.
  if (!secret) {
    return (
      <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
        {overlap}
        <p className="text-[11px] text-muted-foreground/70">
          {template
            ? "Each automation made from this template gets its own URL and secret when it is created."
            : `The URL and the secret a sender needs are given to you once the automation is ${saved ? "saved" : "created"}.`}
        </p>
      </div>
    );
  }

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
        <p className="text-[11px] leading-relaxed text-muted-foreground/70">
          A sender signs the body with it as GitHub does (<code>X-Hub-Signature-256</code>), or
          sends it as <code>Authorization: Bearer &lt;secret&gt;</code>. The request body is added
          below the prompt for the agent to read.
        </p>
      </div>

      {overlap}
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
