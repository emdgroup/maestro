import React, { useState, useCallback } from "react";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { Eye, EyeOff, FileKey, Lock } from "lucide-react";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/ui/field";
import { Checkbox } from "@/ui/checkbox";
import { Label } from "@/ui/label";
import { Input } from "@/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import type { AuthProps, SavedKeyFile } from "./ssh-auth-utils";
import { AuthFooter } from "./PasswordAuth";
import { SetupInstructions } from "./SetupSteps";
import { basename } from "@/lib/path-utils";

export function KeyFileAuth({
  loading,
  onSubmit,
  savedKeyFiles = [],
}: AuthProps & { savedKeyFiles?: SavedKeyFile[] }) {
  const [selectedSavedPath, setSelectedSavedPath] = useState<string | null>(null);
  const [keyPath, setKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [savePassphrase, setSavePassphrase] = useState(false);

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

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        {/* Previously used key files */}
        {savedKeyFiles.length > 0 && (
          <Field>
            <FieldLabel>Keys used before</FieldLabel>
            <div className="space-y-1.5">
              {savedKeyFiles.map(({ path, hasSavedPassphrase }) => {
                const isSelected = selectedSavedPath === path;
                return (
                  <button
                    key={path}
                    type="button"
                    onClick={() => handleSavedKeyClick(path)}
                    disabled={loading}
                    data-selected={isSelected}
                    className="home-pane flex w-full cursor-pointer items-center gap-3 rounded-xl px-3.5 py-2.5 text-left"
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
              {savedKeyFiles.length > 0 ? "Or use a different key" : <> Key file </>}
            </FieldLabel>
            <div className="flex gap-2">
              <Input
                id="key-path"
                type="text"
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder="~/.ssh/id_ed25519"
                disabled={loading}
                autoFocus={savedKeyFiles.length === 0}
                className="font-mono text-sm"
              />
              <button
                type="button"
                disabled={loading}
                onClick={handleBrowse}
                className="home-pill h-9 shrink-0 cursor-pointer rounded-xl px-3 text-xs"
              >
                Browse…
              </button>
            </div>
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
          <div className="home-field flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-xs text-muted-foreground">
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
                <Label htmlFor="save-passphrase" className="cursor-pointer">
                  Remember in the system keychain
                </Label>
              </div>
            </FieldDescription>
          </Field>
        )}
      </FieldGroup>

      <SetupInstructions kind="key-file" />

      <AuthFooter loading={loading} disabled={!activePath} />
    </form>
  );
}
