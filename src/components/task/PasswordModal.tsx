import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Checkbox } from "@/ui/checkbox";
import { Eye, EyeOff } from "lucide-react";
import { useConnectionContext } from "@/contexts/ConnectionContext";

interface PasswordModalProps {
  open: boolean;
  connectionString: string | null;
  onSubmit: (password: string, savePassword: boolean) => void;
  onCancel: () => void;
  loading?: boolean;
}

export function PasswordModal({
  open,
  connectionString,
  onSubmit,
  onCancel,
  loading = false,
}: PasswordModalProps) {
  const [password, setPassword] = useState("");
  const [savePassword, setSavePassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const { activeConnection } = useConnectionContext();

  const handleSubmit = (e: React.SubmitEvent) => {
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
              {connectionString || activeConnection?.displayName}
            </span>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter SSH password"
                  disabled={loading}
                  autoFocus
                  autoComplete="new-password"
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-muted transition-colors [&>svg]:size-4 [&>svg]:text-muted-foreground"
                  disabled={loading}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff /> : <Eye />}
                </button>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="save-password"
                checked={savePassword}
                onCheckedChange={setSavePassword}
                disabled={loading}
              />
              <Label htmlFor="save-password" className="text-sm font-normal cursor-pointer">
                Save password (OS keyring)
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>
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
