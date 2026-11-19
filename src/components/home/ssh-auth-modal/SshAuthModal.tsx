import React, { useState } from "react";
import { FileKey, RectangleEllipsis, ShieldUser } from "lucide-react";
import { HomeSheet } from "@/components/home/HomeSheet";
import { Segmented } from "@/components/common/Segmented";
import type { AuthMethod, AuthSubmission, SavedKeyFile } from "./ssh-auth-utils";
import { PasswordAuth } from "./PasswordAuth";
import { KeyFileAuth } from "./KeyFileAuth";
import { AgentAuth } from "./AgentAuth";

export type { AuthSubmission, SavedKeyFile } from "./ssh-auth-utils";

interface SshAuthModalProps {
  open: boolean;
  username: string;
  /** Shown as the sheet's title. */
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
      title={host ? `${username}@${host}` : "SSH host"}
    >
      <div className="home-form mt-5">
        <div className="text-[11px] text-muted-foreground">Sign in with</div>
        <div className="mt-1 mb-3">
          <Segmented
            size="lg"
            value={activeTab}
            onChange={(tab) => !loading && setActiveTab(tab)}
            options={[
              {
                value: "agent",
                label: (
                  <>
                    <ShieldUser />
                    SSH agent
                  </>
                ),
              },
              {
                value: "key-file",
                label: (
                  <>
                    <FileKey />
                    Key file
                  </>
                ),
              },
              {
                value: "password",
                label: (
                  <>
                    <RectangleEllipsis />
                    Password
                  </>
                ),
              },
            ]}
          />
        </div>
        {authForm[activeTab]}
      </div>
    </HomeSheet>
  );
}
