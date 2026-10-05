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

// ---------------------------------------------------------------------------
// OS detection
// ---------------------------------------------------------------------------

export type OsPlatform = "macos" | "linux" | "windows";

export function detectOs(): OsPlatform {
  const ua = navigator.userAgent;
  if (ua.includes("Win")) return "windows";
  if (ua.includes("Mac")) return "macos";
  return "linux";
}

export const OS = detectOs();
