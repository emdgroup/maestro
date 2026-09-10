import { useCtrlHoldHint } from "@/hooks/useCtrlHoldHint";

export function ShortcutHintProvider({ children }: { children: React.ReactNode }) {
  useCtrlHoldHint();
  return <>{children}</>;
}
