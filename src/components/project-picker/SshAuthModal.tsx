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
  Lock,
} from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/ui/field";
import { Checkbox } from "@/ui/checkbox";
import { Label } from "@/ui/label";
import { Input } from "@/ui/input";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/ui/dialog";
import { ButtonGroup } from "@/ui/button-group";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthSubmission =
  | { method: "password"; password: string; savePassword: boolean }
  | { method: "key-file"; keyPath: string; passphrase?: string; savePassphrase: boolean }
  | { method: "agent" };

export interface SavedKeyFile {
  path: string;
  hasSavedPassphrase: boolean;
}

type AuthMethod = "password" | "key-file" | "agent";

interface SshAuthModalProps {
  open: boolean;
  username: string;
  savedKeyFiles?: SavedKeyFile[];
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
// OS detection
// ---------------------------------------------------------------------------

type OsPlatform = "macos" | "linux" | "windows";

function detectOs(): OsPlatform {
  const ua = navigator.userAgent;
  if (ua.includes("Win")) return "windows";
  if (ua.includes("Mac")) return "macos";
  return "linux";
}

const OS = detectOs();

// ---------------------------------------------------------------------------
// KeyFileAuth
// ---------------------------------------------------------------------------

function KeyFileAuth({
  loading,
  onSubmit,
  savedKeyFiles = [],
}: AuthProps & { savedKeyFiles?: SavedKeyFile[] }) {
  const [selectedSavedPath, setSelectedSavedPath] = useState<string | null>(null);
  const [keyPath, setKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [savePassphrase, setSavePassphrase] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);

  const selectedSaved = savedKeyFiles.find((k) => k.path === selectedSavedPath) ?? null;
  const activePath = (selectedSavedPath ?? keyPath).trim();
  // Show passphrase input unless a saved key with a stored passphrase is selected
  const showPassphraseInput = !selectedSaved?.hasSavedPassphrase;

  const handleSavedKeyClick = (path: string) => {
    setSelectedSavedPath((prev) => (prev === path ? null : path));
    setPassphrase("");
    setSavePassphrase(false);
  };

  const handleBrowse = useCallback(async () => {
    const sshDir = await join(await homeDir(), ".ssh");
    const selected = await openFilePicker({
      title: "Select SSH Private Key",
      defaultPath: sshDir,
      multiple: false,
    });
    if (selected) {
      setKeyPath(selected as string);
      setSelectedSavedPath(null);
    }
  }, []);

  const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!activePath) return;
    onSubmit({
      method: "key-file",
      keyPath: activePath,
      passphrase: selectedSaved?.hasSavedPassphrase ? undefined : passphrase || undefined,
      savePassphrase: showPassphraseInput && !!passphrase && savePassphrase,
    });
  };

  const basename = (path: string) => path.split(/[/\\]/).pop() ?? path;

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        {/* Previously used key files */}
        {savedKeyFiles.length > 0 && (
          <Field>
            <FieldLabel>Previously Used Keys</FieldLabel>
            <div className="space-y-1.5">
              {savedKeyFiles.map(({ path, hasSavedPassphrase }) => {
                const isSelected = selectedSavedPath === path;
                return (
                  <button
                    key={path}
                    type="button"
                    onClick={() => handleSavedKeyClick(path)}
                    disabled={loading}
                    className={cn(
                      "w-full flex items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors",
                      isSelected
                        ? "border-ring bg-accent"
                        : "border-border bg-muted/40 hover:bg-accent/50",
                    )}
                  >
                    <FileKey className="size-4 text-muted-foreground shrink-0" />
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-sm font-medium truncate">{basename(path)}</span>
                      <span className="text-xs text-muted-foreground font-mono truncate">
                        {path}
                      </span>
                    </div>
                    {hasSavedPassphrase && (
                      <Lock className="size-3.5 text-muted-foreground shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </Field>
        )}

        {/* New key path input — visible when no saved key is selected */}
        {!selectedSavedPath && (
          <Field>
            <FieldLabel htmlFor="key-path">
              {savedKeyFiles.length > 0 ? (
                "Or use a different key"
              ) : (
                <>
                  {" "}
                  Private Key Path<span className="text-destructive">*</span>{" "}
                </>
              )}
            </FieldLabel>
            <ButtonGroup>
              <Input
                id="key-path"
                type="text"
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder="~/.ssh/id_rsa"
                disabled={loading}
                autoFocus={savedKeyFiles.length === 0}
                className="font-mono text-sm"
              />
              <Button type="button" variant="outline" disabled={loading} onClick={handleBrowse}>
                Browse
              </Button>
            </ButtonGroup>
          </Field>
        )}

        {/* When a saved key is selected, offer a quick way back to manual entry */}
        {selectedSavedPath && (
          <button
            type="button"
            onClick={() => setSelectedSavedPath(null)}
            disabled={loading}
            className="self-start text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Use a different key
          </button>
        )}

        {/* Saved passphrase info banner */}
        {selectedSaved?.hasSavedPassphrase && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <Lock className="size-4 shrink-0" />
            Passphrase securely saved in keychain
          </div>
        )}

        {/* Passphrase input — shown when there is an active path and no saved passphrase */}
        {activePath && showPassphraseInput && (
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
            <FieldDescription>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="save-passphrase"
                  checked={savePassphrase}
                  onCheckedChange={setSavePassphrase}
                  disabled={loading || !passphrase}
                />
                <Label htmlFor="save-passphrase" className="text-sm font-normal cursor-pointer">
                  Save passphrase (securely stored in OS keychain)
                </Label>
              </div>
            </FieldDescription>
          </Field>
        )}
      </FieldGroup>

      <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3 mt-4">
        <div className="flex items-start gap-3">
          <FileKey className="size-5 text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium">SSH Key Connection</p>
            <p className="text-sm text-muted-foreground mt-1">
              Ensure you have generated your SSH key pair and copied your public key on the remote
              server.
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
          <div className="rounded-md bg-muted p-3 space-y-3 text-xs font-mono text-muted-foreground">
            <div className="space-y-1.5">
              <p className="font-sans font-medium text-foreground text-xs">Generate keys (local)</p>
              <p className="font-sans text-muted-foreground leading-relaxed">
                Generate a new SSH key pair (if you don't have one).
              </p>
              <p className="font-sans text-muted-foreground leading-relaxed">
                Key types: ed25519 (recommended), rsa or ecdsa.
              </p>
              <p className="text-foreground">ssh-keygen -t ed25519 -C "your_email@example.com"</p>
              <p className="font-sans text-muted-foreground leading-relaxed">
                Keys are saved to{" "}
                <span className="font-mono text-foreground">
                  {OS === "windows" ? `$env:USERPROFILE\\.ssh\\` : `~/.ssh/`}
                </span>{" "}
                by default
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="font-sans font-medium text-foreground text-xs">
                Authorize on server (remote)
              </p>
              <p className="font-sans text-muted-foreground leading-relaxed">
                Copy the contents of your public key file (e.g.{" "}
                <span className="font-mono text-foreground">id_ed25519.pub</span>) and place it into{" "}
                <span className="font-mono text-foreground">~/.ssh/authorized_keys</span> on the
                remote server.
              </p>
            </div>
          </div>
        )}
      </div>

      <AuthFooter loading={loading} disabled={!activePath} />
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
