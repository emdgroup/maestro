import React, { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ui/dialog";
import type { AuthMethod, AuthSubmission, SavedKeyFile } from "./ssh-auth-utils";
import { PasswordAuth } from "./PasswordAuth";
import { KeyFileAuth } from "./KeyFileAuth";
import { AgentAuth } from "./AgentAuth";
import { AuthTabBar } from "./AuthTabBar";

export type { AuthSubmission, SavedKeyFile } from "./ssh-auth-utils";

interface SshAuthModalProps {
  open: boolean;
  username: string;
  savedKeyFiles?: SavedKeyFile[];
  onSubmit: (auth: AuthSubmission) => void;
  onCancel: () => void;
  loading?: boolean;
}

export function SshAuthModal({
  open,
  username,
  savedKeyFiles = [],
  onSubmit,
  onCancel,
  loading = false,
}: SshAuthModalProps) {
  const [activeTab, setActiveTab] = useState<AuthMethod>("password");
  const authProps = { loading, onSubmit };

  const authForm: Record<AuthMethod, React.ReactNode> = {
    password: <PasswordAuth username={username} {...authProps} />,
    "key-file": <KeyFileAuth savedKeyFiles={savedKeyFiles} {...authProps} />,
    agent: <AgentAuth {...authProps} />,
  };

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>SSH Authentication Required</DialogTitle>
          <DialogDescription>
            Choose an authentication method to connect to the remote server.
          </DialogDescription>
        </DialogHeader>

        <AuthTabBar active={activeTab} onChange={setActiveTab} disabled={loading} />

        {authForm[activeTab]}
      </DialogContent>
    </Dialog>
  );
}
