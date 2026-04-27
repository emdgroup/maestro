import { ShieldOff } from "lucide-react";
import type { PermissionDeniedItem } from "./types";

interface PermissionDeniedCardProps {
  item: PermissionDeniedItem;
}

function targetLabel(payload: Record<string, unknown>): string {
  const tool = (payload.tool as string | undefined) ?? "";
  const path = payload.path as string | undefined;
  const command = (payload.command ?? payload.cmd) as string | undefined;

  if (/command|bash|shell/i.test(tool) && command) return `Run command: ${command}`;
  if (path) return `${tool ? `${tool}: ` : ""}${path}`;
  return JSON.stringify(payload);
}

export function PermissionDeniedCard({ item }: PermissionDeniedCardProps) {
  return (
    <div className="ml-9 bg-destructive/5 border border-destructive/20 rounded-md px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-destructive text-[11px] font-semibold uppercase tracking-wide mb-1">
        <ShieldOff className="w-3 h-3" />
        Permission denied
      </div>
      <div className="text-muted-foreground text-xs font-mono">{targetLabel(item.payload)}</div>
    </div>
  );
}
