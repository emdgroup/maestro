import React, { useState } from "react";
import { ShieldUser, ChevronDown, ChevronUp } from "lucide-react";
import type { AuthProps } from "./ssh-auth-utils";
import { OS } from "./ssh-auth-utils";
import { AuthFooter } from "./PasswordAuth";

export function AgentAuth({ loading, onSubmit }: AuthProps) {
  const [showInstructions, setShowInstructions] = useState(false);

  const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSubmit({ method: "agent" });
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3">
        <div className="flex items-start gap-3">
          <ShieldUser className="size-5 text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium">SSH Agent Connection</p>
            <p className="text-sm text-muted-foreground mt-1">
              Ensure you have a running SSH agent with your key loaded. Check instructions for help.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowInstructions(!showInstructions)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {showInstructions ? (
            <ChevronUp className="w-3 h-3" />
          ) : (
            <ChevronDown className="w-3 h-3" />
          )}
          Setup instructions
        </button>
        {showInstructions && (
          <div className="rounded-md bg-muted p-3 space-y-1.5 text-xs font-mono text-muted-foreground">
            <p className="font-sans font-medium text-foreground text-xs mb-2">
              On your local environment:
            </p>
            {OS === "windows" && (
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
            {OS === "macos" && (
              <>
                <p># macOS starts ssh-agent automatically</p>
                <p className="mt-1"># Verify key is loaded</p>
                <p className="text-foreground">ssh-add -l</p>
                <p className="mt-1"># Add your private key, can be rsa, ecdsa or ed25519</p>
                <p className="text-foreground">ssh-add --apple-use-keychain ~/.ssh/id_ed25519</p>
              </>
            )}
            {OS === "linux" && (
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
        )}
      </div>
      <AuthFooter loading={loading} />
    </form>
  );
}
