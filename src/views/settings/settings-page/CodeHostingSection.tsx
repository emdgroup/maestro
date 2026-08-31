import { useState } from "react";
import { Check, Cloud, GitMerge, GitPullRequest, Upload } from "lucide-react";
import { BrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { Button } from "@/ui/button";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import { IntegrationConnectDialog } from "@/views/project-picker/integrations-tab/IntegrationConnectDialog";
import {
  PROVIDER_NAMES,
  useCodeHostingStatus,
  useSaveProjectLandingMode,
} from "@/services/integration.service";
import { useProjectRemotes } from "@/services/project.service";
import type { CodeHostingStatus, LandingMode, ProjectConfigRequest } from "@/types/bindings";

/**
 * `Select` needs a non-empty string per option, and "auto" is the absence of a choice rather than
 * a remote anyone can be named. This sentinel maps between the two; it is never persisted.
 */
const AUTO_REMOTE = "__auto__";

/**
 * Which remote this project pushes to.
 *
 * A picker rather than a text field: this name decides where an approved branch is pushed, what
 * the branch picker's Remote tab lists, and which branches the prune dialog considers safely
 * pushed. A typo would endanger all three with nothing on screen to say why.
 */
function RemoteSelect({
  value,
  remotes,
  onChange,
}: {
  value: string | null;
  remotes: string[];
  onChange: (remote: string | null) => void;
}) {
  // A configured remote the project no longer has still has to be selectable, or the picker would
  // silently show "Auto" while the stored setting says otherwise.
  const options = value && !remotes.includes(value) ? [...remotes, value] : remotes;

  return (
    <Select
      value={value ?? AUTO_REMOTE}
      onValueChange={(next) => onChange(next === AUTO_REMOTE ? null : next)}
    >
      <SelectTrigger
        id="git-remote"
        className="w-full border-border bg-transparent shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
      >
        <span className="flex items-center gap-2 min-w-0 flex-1 text-left">
          <Cloud className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm">{value ?? "Auto-detect"}</span>
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AUTO_REMOTE}>
          <span className="block text-sm">Auto-detect</span>
          <span className="block text-xs text-muted-foreground">
            origin, then upstream, then the first remote
          </span>
        </SelectItem>
        {options.map((remote) => (
          <SelectItem key={remote} value={remote}>
            <span className="text-sm font-mono">{remote}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/// What each way of landing work does, in the order of how much of it Maestro performs.
const LANDING_MODES: {
  value: LandingMode;
  label: string;
  description: string;
  icon: typeof GitMerge;
}[] = [
  {
    value: "Merge",
    label: "Merge locally",
    description: "Merge into the base branch and delete the worktree",
    icon: GitMerge,
  },
  {
    value: "PullRequest",
    label: "Open a pull request",
    description: "Push the branch and open a pull request on the forge",
    icon: GitPullRequest,
  },
  {
    value: "PushOnly",
    label: "Push only",
    description: "Push the branch and leave landing it to someone else",
    icon: Upload,
  },
];

/**
 * Why the chosen mode cannot happen right now, or null when it can.
 *
 * Approve falls back to merging locally in each of these cases, so the setting stays selectable
 * and this sentence explains the gap rather than the option being disabled. A project is often
 * configured before its forge is connected, and a control that refuses the choice would make that
 * order impossible.
 */
function unreachableReason(mode: LandingMode, status: CodeHostingStatus): string | null {
  if (mode === "Merge") return null;
  if (status.rung === "NoRemote") {
    return "This project has no remote to push to, so Approve will merge locally.";
  }
  if (mode === "PushOnly") return null;
  if (!status.forge_supports_pull_requests) {
    const name = status.config
      ? (PROVIDER_NAMES[status.config.provider] ?? status.config.provider)
      : "This host";
    return `Maestro cannot open pull requests on ${name}, so Approve will merge locally.`;
  }
  if (status.rung === "NotConnected") {
    const name = status.config
      ? (PROVIDER_NAMES[status.config.provider] ?? status.config.provider)
      : "the forge";
    return `Connect ${name} above to open pull requests. Until then Approve will merge locally.`;
  }
  return null;
}

/**
 * Where this project's code lives, and whether Maestro can act on it.
 *
 * Everything here is read from `get_project_code_hosting_status`, which re-runs rather than
 * caching because the top rung asks whether a credential answers *right now*. The one thing this
 * card writes is the landing mode.
 *
 * It exists because the Approve modal already tells people to "connect {provider} in Settings",
 * and until now Settings had nowhere to do that for a forge.
 */
export function CodeHostingSection({
  projectId,
  remoteName,
  onChange,
}: {
  projectId: number;
  /** Null means auto-detect; see `RemoteSelect`. */
  remoteName: string | null;
  /** Persists immediately, this section has no Save button behind it. */
  onChange: (patch: Partial<ProjectConfigRequest>) => void;
}) {
  const { data: status, isLoading } = useCodeHostingStatus(projectId);
  const { data: remotes = [] } = useProjectRemotes(projectId);
  const saveLandingMode = useSaveProjectLandingMode();
  const [connectProvider, setConnectProvider] = useState<string | null>(null);

  if (isLoading || !status) return null;

  const provider = status.config?.provider ?? null;
  const providerName = provider ? (PROVIDER_NAMES[provider] ?? provider) : null;
  const selected = LANDING_MODES.find((m) => m.value === status.landing_mode) ?? LANDING_MODES[0];
  const SelectedIcon = selected.icon;
  const reason = unreachableReason(status.landing_mode, status);

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
          <Cloud className="w-4 h-4 text-muted-foreground" />
          Code hosting
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          Where this project&apos;s branches are pushed, and what Maestro can do there when you
          approve a task.
        </p>
      </div>

      <div className="space-y-2">
        <div className="min-w-0">
          <Label htmlFor="git-remote" className="text-sm font-medium text-foreground">
            Git remote
          </Label>
          <div className="text-xs text-muted-foreground">
            Which remote Maestro pushes to and lists branches from.
          </div>
        </div>
        <RemoteSelect
          value={remoteName}
          remotes={remotes}
          onChange={(remote) => onChange({ remote_name: remote })}
        />
      </div>

      {status.rung === "NoRemote" ? (
        <p className="text-sm text-muted-foreground">
          This project has no git remote. Approved work is merged locally.
        </p>
      ) : (
        <>
          {/* Where the choice above lands, resolved. The URL rather than just the name, because
              a name says nothing about which server it reaches, which is the whole question on a
              machine with several accounts. */}
          <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 space-y-0.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {status.remote}
            </div>
            <div className="text-xs font-mono break-all text-foreground">{status.remote_url}</div>
          </div>

          {provider == null ? (
            <p className="text-xs text-muted-foreground">
              Maestro does not recognise this host, so it can push but cannot open pull requests.
            </p>
          ) : (
            // The same shape as the detected-provider row on the Issue tracking page, so the two
            // settings pages offer the same affordance the same way.
            <div
              className={`flex items-center gap-3 rounded-lg border p-3 ${
                status.rung === "Ready" ? "border-border" : "border-dashed border-border/70"
              }`}
            >
              <BrandIcon slug={provider} className="w-5 h-5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium flex items-center gap-1.5">
                  {providerName}
                  {status.rung === "Ready" && <Check className="size-3.5 text-accent shrink-0" />}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {status.config?.project_path}
                  {status.rung === "Ready"
                    ? status.forge_supports_pull_requests
                      ? ". Connected, pull requests available"
                      : ". Connected, but Maestro cannot open pull requests here"
                    : status.forge_supports_pull_requests
                      ? ". Connect an account to open pull requests"
                      : ". Maestro cannot open pull requests here"}
                </p>
              </div>
              {/* Inviting someone to connect a forge that still could not open a pull request
                  would ask for work that changes nothing, which is the same rule the Approve
                  modal applies to its own invitation. */}
              {status.rung === "NotConnected" && status.forge_supports_pull_requests && (
                <Button type="button" size="sm" onClick={() => setConnectProvider(provider)}>
                  Connect
                </Button>
              )}
            </div>
          )}
        </>
      )}

      <div className="space-y-2">
        <div className="min-w-0">
          <Label htmlFor="landing-mode" className="text-sm font-medium text-foreground">
            When a task is approved
          </Label>
          <div className="text-xs text-muted-foreground">
            What the Approve dialog starts on. You can still pick something else for an individual
            task.
          </div>
        </div>
        <Select
          value={status.landing_mode}
          onValueChange={(next) => {
            if (next) saveLandingMode.mutate({ projectId, landingMode: next as LandingMode });
          }}
        >
          {/* See `WorkspaceModeSelect` on why the height override has to carry the size variant. */}
          <SelectTrigger
            id="landing-mode"
            className="w-full data-[size=default]:h-auto py-2 px-3 border-border bg-transparent shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
          >
            <span className="flex items-center gap-2 min-w-0 flex-1 text-left">
              <SelectedIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm truncate">{selected.label}</span>
                <span className="block text-xs text-muted-foreground truncate">
                  {selected.description}
                </span>
              </span>
            </span>
          </SelectTrigger>
          <SelectContent>
            {LANDING_MODES.map((mode) => {
              const Icon = mode.icon;
              return (
                <SelectItem key={mode.value} value={mode.value} className="py-2">
                  <span className="flex items-center gap-2 min-w-0">
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block text-sm">{mode.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {mode.description}
                      </span>
                    </span>
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        {reason && <p className="text-xs text-warning">{reason}</p>}
      </div>

      <IntegrationConnectDialog
        provider={connectProvider ?? ""}
        open={connectProvider !== null}
        onOpenChange={(open) => {
          if (!open) setConnectProvider(null);
        }}
        // Nothing to record here: the status query is re-read after a connect, and it asks the
        // credential store directly rather than reading anything this dialog could have written.
        onSuccess={() => setConnectProvider(null)}
      />
    </div>
  );
}
