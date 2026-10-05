import React from "react";
import { motion } from "framer-motion";
import { RectangleEllipsis, ShieldUser, FileKey } from "lucide-react";
import type { AuthMethod } from "./ssh-auth-utils";

export const TABS: { id: AuthMethod; label: string; icon: React.ReactNode }[] = [
  { id: "password", label: "Password", icon: <RectangleEllipsis className="size-8" /> },
  { id: "key-file", label: "SSH Key", icon: <FileKey className="size-8" /> },
  { id: "agent", label: "Agent", icon: <ShieldUser className="size-8" /> },
];

export function AuthTabBar({
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
