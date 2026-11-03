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

export type AuthMethod = "password" | "key-file" | "agent";

export interface AuthProps {
  loading: boolean;
  onSubmit: (auth: AuthSubmission) => void;
}
