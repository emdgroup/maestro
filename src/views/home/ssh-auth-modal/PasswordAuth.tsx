import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/ui/field";
import { Checkbox } from "@/ui/checkbox";
import { Label } from "@/ui/label";
import { Button } from "@/ui/button";
import { DialogFooter, DialogClose } from "@/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import type { AuthProps } from "./ssh-auth-utils";

// ---------------------------------------------------------------------------
// Shared footer
// ---------------------------------------------------------------------------

export function AuthFooter({ loading, disabled }: { loading: boolean; disabled?: boolean }) {
  return (
    <DialogFooter className="mt-4">
      <DialogClose render={<Button variant="outline">Cancel</Button>} />
      <Button type="submit" disabled={loading || disabled}>
        {loading ? "Connecting..." : "Connect"}
      </Button>
    </DialogFooter>
  );
}

// ---------------------------------------------------------------------------
// PasswordAuth
// ---------------------------------------------------------------------------

export function PasswordAuth({ username, loading, onSubmit }: AuthProps & { username: string }) {
  const [password, setPassword] = useState("");
  const [savePassword, setSavePassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!password.trim()) return;
    onSubmit({ method: "password", password, savePassword });
    setPassword("");
    setSavePassword(false);
  };

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="ssh-password">
            Password<span className="text-destructive">*</span>
          </FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="ssh-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={`Enter password for ${username}`}
              disabled={loading}
              autoFocus
              autoComplete="new-password"
              className="pr-10"
              required
            />
            <InputGroupAddon align="inline-end">
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="[&>svg]:text-muted-foreground [&>svg:hover]:text-foreground"
                disabled={loading}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff /> : <Eye />}
              </button>
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="save-password"
                checked={savePassword}
                onCheckedChange={setSavePassword}
                disabled={loading}
              />
              <Label htmlFor="save-password" className="text-sm font-normal cursor-pointer">
                Save password (securely stored in OS keychain)
              </Label>
            </div>
          </FieldDescription>
        </Field>
      </FieldGroup>
      <AuthFooter loading={loading} disabled={!password.trim()} />
    </form>
  );
}
