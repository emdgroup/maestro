import React from "react";
import type { AuthProps } from "./ssh-auth-utils";
import { AuthFooter } from "./PasswordAuth";
import { SetupInstructions } from "./SetupSteps";

export function AgentAuth({ loading, onSubmit }: AuthProps) {
  const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSubmit({ method: "agent" });
  };

  return (
    <form onSubmit={handleSubmit}>
      <p className="text-xs text-muted-foreground">
        Uses the keys your SSH agent already holds. Nothing is stored by Maestro.
      </p>
      <SetupInstructions kind="agent" />
      <AuthFooter loading={loading} />
    </form>
  );
}
