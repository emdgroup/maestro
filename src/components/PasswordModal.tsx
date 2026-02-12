import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Checkbox } from "./ui/checkbox";
import { SshConnection } from "../types/bindings";

interface PasswordModalProps {
  open: boolean;
  connection: SshConnection | null;
  onSubmit: (password: string, savePassword: boolean) => void;
  onCancel: () => void;
  loading?: boolean;
}

export function PasswordModal({
  open,
  connection,
  onSubmit,
  onCancel,
  loading = false,
}: PasswordModalProps) {
  const [password, setPassword] = useState("");
  const [savePassword, setSavePassword] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.trim()) {
      onSubmit(password, savePassword);
      setPassword("");
      setSavePassword(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>SSH Authentication Required</DialogTitle>
          <DialogDescription>
            Enter password for{" "}
            <span className="font-mono font-semibold">
              {connection?.connection_string}
            </span>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter SSH password"
                disabled={loading}
                autoFocus
              />
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="save-password"
                checked={savePassword}
                onCheckedChange={(checked) => setSavePassword(checked === true)}
                disabled={loading}
              />
              <Label
                htmlFor="save-password"
                className="text-sm font-normal cursor-pointer"
              >
                Save password securely (OS keyring)
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !password.trim()}>
              {loading ? "Connecting..." : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
