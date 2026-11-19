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
      <SetupInstructions kind="agent" />
      <AuthFooter loading={loading} />
    </form>
  );
}
