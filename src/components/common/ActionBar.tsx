import React from "react";
import { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ActionBarAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  variant?: "default" | "outline" | "ghost" | "destructive" | "accent";
  onClick: () => void;
  visible?: boolean;
  disabled?: boolean;
  align?: "left" | "right";
}

interface ActionBarProps {
  actions: ActionBarAction[];
}

export const ActionBar: React.FC<ActionBarProps> = ({ actions }) => {
  const visibleActions = actions.filter((action) => action.visible !== false);
  const leftActions = visibleActions.filter((action) => action.align !== "right");
  const rightActions = visibleActions.filter((action) => action.align === "right");

  if (visibleActions.length === 0) {
    return null;
  }

  return (
    <div className="h-12 border-b border-border bg-muted/30 flex items-center justify-between px-4 gap-2">
      <div className="flex items-center gap-2">
        {leftActions.map((action) => (
          <Button
            key={action.id}
            variant={action.variant || "default"}
            size="sm"
            onClick={action.onClick}
            disabled={action.disabled}
            className="h-8"
          >
            {action.icon && <action.icon className="w-4 h-4" />}
            {action.label}
          </Button>
        ))}
      </div>
      {rightActions.length > 0 && (
        <div className="flex items-center gap-2">
          {rightActions.map((action) => (
            <Button
              key={action.id}
              variant={action.variant || "default"}
              size="sm"
              onClick={action.onClick}
              disabled={action.disabled}
              className="h-8"
            >
              {action.icon && <action.icon className="w-4 h-4" />}
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
};
