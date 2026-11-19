import React, { useState } from "react";
import { HomeSheet } from "@/components/home/HomeSheet";
import { Segmented } from "@/components/common/Segmented";
import type { AuthMethod, AuthSubmission, SavedKeyFile } from "./ssh-auth-utils";
import { PasswordAuth } from "./PasswordAuth";
import { KeyFileAuth } from "./KeyFileAuth";
import { AgentAuth } from "./AgentAuth";
import { SIGN_IN_ITEM, SIGN_IN_OPTIONS } from "./SetupSteps";

export type { AuthSubmission, SavedKeyFile } from "./ssh-auth-utils";

interface SshAuthModalProps {
  open: boolean;
  username: string;
  /** Shown under the title, after `username@`. */
  host?: string;
  savedKeyFiles?: SavedKeyFile[];
  onSubmit: (auth: AuthSubmission) => void;
  onCancel: () => void;
  loading?: boolean;
}

export function SshAuthModal({
  open,
  username,
  host,
  savedKeyFiles = [],
  onSubmit,
  onCancel,
  loading = false,
}: SshAuthModalProps) {
  const [activeTab, setActiveTab] = useState<AuthMethod>("agent");
  const authProps = { loading, onSubmit };

  const authForm: Record<AuthMethod, React.ReactNode> = {
    password: <PasswordAuth username={username} {...authProps} />,
    "key-file": <KeyFileAuth savedKeyFiles={savedKeyFiles} {...authProps} />,
    agent: <AgentAuth {...authProps} />,
  };

  return (
    <HomeSheet
      open={open}
      onOpenChange={(open) => !open && onCancel()}
      eyebrow="Sign in"
      title="SSH host"
    >
      {host && (
        <div
          title={`${username}@${host}`}
          className="mt-1 truncate font-mono text-xs text-muted-foreground"
        >
          {username}@{host}
        </div>
      )}
      <div className="home-form mt-5">
        <div className="text-[11px] text-muted-foreground">Sign in with</div>
        <div className="mt-1 mb-3">
          <Segmented
            size="lg"
            value={activeTab}
            onChange={(tab) => !loading && setActiveTab(tab)}
            options={SIGN_IN_OPTIONS}
            itemClassName={SIGN_IN_ITEM}
          />
        </div>
        {authForm[activeTab]}
      </div>
    </HomeSheet>
  );
}
