import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import type { AvailableCommand } from "../types";

interface Params {
  commands: AvailableCommand[];
}

export function useCommandAutocomplete({ commands }: Params) {
  const [showCommands, setShowCommands] = useState(false);
  const [commandFilter, setCommandFilter] = useState("");
  const [commandHighlight, setCommandHighlight] = useState(0);
  const [commandTriggerOffset, setCommandTriggerOffset] = useState(0);
  const commandButtonRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  // Offset of a "/" the user dismissed with Escape. Without this the panel would
  // reopen on the very next keystroke, since the trigger is still there.
  const dismissedOffset = useRef<number | null>(null);

  const filteredCommands = useMemo(
    () => commands.filter((cmd) => cmd.name.toLowerCase().startsWith(commandFilter.toLowerCase())),
    [commands, commandFilter],
  );

  useEffect(() => {
    const button = commandButtonRefs.current.get(commandHighlight);
    if (button) button.scrollIntoView({ block: "nearest" });
  }, [commandHighlight]);

  // Returns true if the cursor sits in a command token (caller should close mentions),
  // whether or not the panel is showing — Escape suppresses the panel, not the token.
  const onInputChange = useCallback((value: string, cursor: number): boolean => {
    const before = value.slice(0, cursor);
    const slash = before.lastIndexOf("/");
    const token = slash === -1 ? "" : before.slice(slash + 1);
    // A "/" only triggers at the start or after whitespace, and only while the
    // token stays command-shaped: a space or a second "/" means prose or a path.
    if (slash === -1 || (slash > 0 && !/\s/.test(before[slash - 1])) || /[\s/]/.test(token)) {
      dismissedOffset.current = null;
      setShowCommands(false);
      return false;
    }
    if (dismissedOffset.current === slash) return true;
    setCommandTriggerOffset(slash);
    setCommandFilter(token);
    setShowCommands(true);
    setCommandHighlight(0);
    return true;
  }, []);

  // Returns true if the event was consumed
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, onSelectCommand: (cmd: AvailableCommand) => void): boolean => {
      if (!showCommands || filteredCommands.length === 0) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCommandHighlight((i) => (i + 1) % filteredCommands.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCommandHighlight((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        onSelectCommand(filteredCommands[commandHighlight]);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismissedOffset.current = commandTriggerOffset;
        setShowCommands(false);
        return true;
      }
      return false;
    },
    [showCommands, filteredCommands, commandHighlight, commandTriggerOffset],
  );

  const reset = useCallback(() => {
    dismissedOffset.current = null;
    setShowCommands(false);
    setCommandFilter("");
    setCommandHighlight(0);
  }, []);

  return {
    showCommands,
    setShowCommands,
    filteredCommands,
    commandHighlight,
    commandTriggerOffset,
    commandButtonRefs,
    onInputChange,
    handleKeyDown,
    reset,
  };
}
