import React, { useState, useCallback } from "react";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { motion } from "framer-motion";
import {
  Eye,
  EyeOff,
  RectangleEllipsis,
  ShieldUser,
  ChevronDown,
  ChevronUp,
  FileKey,
} from "lucide-react";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Checkbox,
  Label,
  Input,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
  ButtonGroup,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthSubmission =
  | { method: "password"; password: string; savePassword: boolean }
  | { method: "key-file"; keyPath: string; passphrase?: string }
  | { method: "agent" };

type AuthMethod = "password" | "key-file" | "agent";

interface SshAuthModalProps {
  open: boolean;
  username: string;
  onSubmit: (auth: AuthSubmission) => void;
  onCancel: () => void;
  loading?: boolean;
}

interface AuthProps {
  loading: boolean;
  onSubmit: (auth: AuthSubmission) => void;
}

// ---------------------------------------------------------------------------
// Shared footer
// ---------------------------------------------------------------------------

function AuthFooter({ loading, disabled }: { loading: boolean; disabled?: boolean }) {
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

function PasswordAuth({ username, loading, onSubmit }: AuthProps & { username: string }) {
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

// ---------------------------------------------------------------------------
// KeyFileAuth
// ---------------------------------------------------------------------------

function KeyFileAuth({ loading, onSubmit }: AuthProps) {
  const [keyPath, setKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);

  const handleBrowse = useCallback(async () => {
    const sshDir = await join(await homeDir(), ".ssh");
    const selected = await openFilePicker({
      title: "Select SSH Private Key",
      defaultPath: sshDir,
      multiple: false
    });
    if (selected) setKeyPath(selected as string);
  }, []);

  const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!keyPath.trim()) return;
    onSubmit({ method: "key-file", keyPath: keyPath.trim(), passphrase: passphrase || undefined });
  };

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="key-path">
            Private Key Path<span className="text-destructive">*</span>
          </FieldLabel>
          <ButtonGroup>
            <Input
              id="key-path"
              type="text"
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              placeholder="~/.ssh/id_rsa"
              disabled={loading}
              autoFocus
              className="font-mono text-sm"
              required
            />
            <Button type="button" variant="outline" disabled={loading} onClick={handleBrowse}>
              Browse
            </Button>
          </ButtonGroup>
        </Field>
        <Field>
          <FieldLabel htmlFor="passphrase">Passphrase (optional)</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="passphrase"
              type={showPassphrase ? "text" : "password"}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Leave empty if key has no passphrase"
              disabled={loading}
              autoComplete="new-password"
              className="pr-10"
            />
            <InputGroupAddon align="inline-end">
              <button
                type="button"
                onClick={() => setShowPassphrase(!showPassphrase)}
                className="[&>svg]:text-muted-foreground [&>svg:hover]:text-foreground"
                disabled={loading}
                aria-label={showPassphrase ? "Hide passphrase" : "Show passphrase"}
              >
                {showPassphrase ? <EyeOff /> : <Eye />}
              </button>
            </InputGroupAddon>
          </InputGroup>
        </Field>
      </FieldGroup>
      <AuthFooter loading={loading} disabled={!keyPath.trim()} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// AgentAuth
// ---------------------------------------------------------------------------

function AgentAuth({ loading, onSubmit }: AuthProps) {
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
              Maestro will connect automatically to your running SSH agent. If it does not, ensure the agent is running and has your key loaded.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowInstructions(!showInstructions)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {showInstructions ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
           instructions
        </button>
        {showInstructions && (
          <div className="rounded-md bg-muted p-3 space-y-1.5 text-xs font-mono text-muted-foreground">
            <p className="font-sans font-medium text-foreground text-xs mb-2">
              Run these commands on your local machine:
            </p>
            <p># Start the SSH agent</p>
            <p className="text-foreground">{'eval "$(ssh-agent -s)"'}</p>
            <p className="mt-1"># Verify key is loaded</p>
            <p className="text-foreground">ssh-add -l</p>
            <p className="mt-1"># Add your private key</p>
            <p className="text-foreground">ssh-add ~/.ssh/id_ed25519</p>
          </div>
        )}
      </div>
      <AuthFooter loading={loading} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

const TABS: { id: AuthMethod; label: string; icon: React.ReactNode }[] = [
  { id: "password", label: "Password", icon: <RectangleEllipsis className="size-8" /> },
  { id: "key-file", label: "SSH Key", icon: <FileKey className="size-8" /> },
  { id: "agent", label: "Agent", icon: <ShieldUser className="size-8" /> },
];

function AuthTabBar({
  active,
  onChange,
  disabled,
}: {
  active: AuthMethod;
  onChange: (tab: AuthMethod) => void;
  disabled: boolean;
}) {
  const activeIndex = TABS.findIndex((t) => t.id === active);

  return (
    <div className="relative flex rounded-lg bg-muted p-1">
      <motion.span
        className="absolute inset-y-1 left-1 rounded-md bg-background shadow-sm"
        style={{ width: "calc((100% - 0.5rem) / 3)" }}
        animate={{ x: `calc(${activeIndex} * 100%)` }}
        transition={{ type: "spring", stiffness: 500, damping: 35 }}
      />
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          disabled={disabled}
          className="relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium"
        >
          <motion.span
            animate={{ color: active === tab.id ? "var(--foreground)" : "var(--muted-foreground)" }}
            transition={{ duration: 0.15 }}
            className="flex items-center gap-1.5"
          >
            {tab.icon}
            {tab.label}
          </motion.span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SshAuthModal
// ---------------------------------------------------------------------------

export function SshAuthModal({
  open,
  username,
  onSubmit,
  onCancel,
  loading = false,
}: SshAuthModalProps) {
  const [activeTab, setActiveTab] = useState<AuthMethod>("password");
  const authProps = { loading, onSubmit };

  const authForm: Record<AuthMethod, React.ReactNode> = {
    "password": <PasswordAuth username={username} {...authProps} />,
    "key-file": <KeyFileAuth {...authProps} />,
    "agent": <AgentAuth {...authProps} />
  }

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
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
