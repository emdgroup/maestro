import { ChevronRight, FileKey, RectangleEllipsis, ShieldUser } from "lucide-react";
import { cn } from "@/lib/utils";
import { hostPlatform } from "@/lib/platform-utils";
import type { AuthMethod } from "./ssh-auth-utils";

const STEPS = "home-field rounded-xl px-3.5 py-3";
const ICON = "size-5";

/** The ways to sign in to an SSH host, for the `Segmented` picker of every SSH form. */
export const SIGN_IN_OPTIONS: { value: AuthMethod; label: React.ReactNode }[] = [
  {
    value: "agent",
    label: (
      <>
        <ShieldUser className={ICON} />
        SSH agent
      </>
    ),
  },
  {
    value: "key-file",
    label: (
      <>
        <FileKey className={ICON} />
        Key file
      </>
    ),
  },
  {
    value: "password",
    label: (
      <>
        <RectangleEllipsis className={ICON} />
        Password
      </>
    ),
  },
];

/** Taller segments so the icons fit. */
export const SIGN_IN_ITEM = "h-10 gap-2";

const DESCRIPTION: Partial<Record<AuthMethod, string>> = {
  agent: "Ensure you have a running SSH agent with your key loaded. Nothing is stored by Maestro.",
  "key-file":
    "Ensure you have generated your SSH key pair and copied your public key on the remote server.",
};

/** What a way of signing in needs, then a collapsed `Setup instructions` toggle over its steps. */
export function SetupInstructions({ kind }: { kind: AuthMethod }) {
  if (kind === "password") return null;
  return (
    <div className="mt-2 text-xs text-muted-foreground">
      <p>{DESCRIPTION[kind]}</p>
      <details className="group mt-2">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
          Setup instructions
        </summary>
        <div className="mt-2">{kind === "agent" ? <AgentSetupSteps /> : <KeySetupSteps />}</div>
      </details>
    </div>
  );
}

/** How to get a key into the local SSH agent, for the platform Maestro runs on. */
function AgentSetupSteps() {
  return (
    <div className={cn(STEPS, "space-y-1.5 text-xs font-mono text-muted-foreground")}>
      <p className="font-sans font-medium text-foreground text-xs mb-2">
        On your local environment:
      </p>
      {hostPlatform === "windows" && (
        <>
          <p># Enable and start the SSH agent service (run as Admin)</p>
          <p className="text-foreground">
            Get-Service ssh-agent | Set-Service -StartupType Automatic
          </p>
          <p className="text-foreground">Start-Service ssh-agent</p>
          <p className="mt-1"># Verify key is loaded</p>
          <p className="text-foreground">ssh-add -l</p>
          <p className="mt-1"># Add your private key, can be rsa, ecdsa or ed25519.</p>
          <p className="text-foreground">ssh-add $env:USERPROFILE\.ssh\id_ed25519</p>
        </>
      )}
      {hostPlatform === "macos" && (
        <>
          <p># macOS starts ssh-agent automatically</p>
          <p className="mt-1"># Verify key is loaded</p>
          <p className="text-foreground">ssh-add -l</p>
          <p className="mt-1"># Add your private key, can be rsa, ecdsa or ed25519</p>
          <p className="text-foreground">ssh-add --apple-use-keychain ~/.ssh/id_ed25519</p>
        </>
      )}
      {hostPlatform === "linux" && (
        <>
          <p># Start the SSH agent</p>
          <p className="text-foreground">eval "$(ssh-agent -s)"</p>
          <p className="mt-1"># Verify key is loaded</p>
          <p className="text-foreground">ssh-add -l</p>
          <p className="mt-1"># Add your private key, can be rsa, ecdsa or ed25519.</p>
          <p className="text-foreground">ssh-add ~/.ssh/id_ed25519</p>
        </>
      )}
    </div>
  );
}

/** How to make a key pair and authorize it on the remote host. */
function KeySetupSteps() {
  return (
    <div className={cn(STEPS, "space-y-3 text-xs font-mono text-muted-foreground")}>
      <div className="space-y-1.5">
        <p className="font-sans font-medium text-foreground text-xs">Generate keys (local)</p>
        <p className="font-sans text-muted-foreground leading-relaxed">
          Generate a new SSH key pair (if you don't have one).
        </p>
        <p className="font-sans text-muted-foreground leading-relaxed">
          Key types: ed25519 (recommended), rsa or ecdsa.
        </p>
        <p className="text-foreground">ssh-keygen -t ed25519 -C "your_email@example.com"</p>
        <p className="font-sans text-muted-foreground leading-relaxed">
          Keys are saved to{" "}
          <span className="font-mono text-foreground">
            {hostPlatform === "windows" ? `$env:USERPROFILE\\.ssh\\` : `~/.ssh/`}
          </span>{" "}
          by default
        </p>
      </div>
      <div className="space-y-1.5">
        <p className="font-sans font-medium text-foreground text-xs">
          Authorize on server (remote)
        </p>
        <p className="font-sans text-muted-foreground leading-relaxed">
          Copy the contents of your public key file (e.g.{" "}
          <span className="font-mono text-foreground">id_ed25519.pub</span>) and place it into{" "}
          <span className="font-mono text-foreground">~/.ssh/authorized_keys</span> on the remote
          server.
        </p>
      </div>
    </div>
  );
}
