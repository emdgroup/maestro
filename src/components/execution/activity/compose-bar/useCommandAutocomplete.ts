import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import type { AvailableCommand } from "../types";

interface Params {
  commands: AvailableCommand[];
}

export function useCommandAutocomplete({ commands }: Params) {
  const [showCommands, setShowCommands] = useState(false);
  const [commandFilter, setCommandFilter] = useState("");
  const [commandHighlight, setCommandHighlight] = useState(0);
  const commandButtonRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  const filteredCommands = useMemo(
    () => commands.filter((cmd) => cmd.name.toLowerCase().startsWith(commandFilter.toLowerCase())),
    [commands, commandFilter],
  );

  useEffect(() => {
    const button = commandButtonRefs.current.get(commandHighlight);
    if (button) button.scrollIntoView({ block: "nearest" });
  }, [commandHighlight]);

  // Returns true if a command trigger was detected (caller should close mentions)
  const onInputChange = useCallback((value: string): boolean => {
    const trimmed = value.trimStart();
    if (trimmed.startsWith("/") && !trimmed.includes(" ")) {
      setCommandFilter(trimmed.slice(1));
      setShowCommands(true);
      setCommandHighlight(0);
      return true;
    }
    setShowCommands(false);
    return false;
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
        setShowCommands(false);
        return true;
      }
      return false;
    },
    [showCommands, filteredCommands, commandHighlight],
  );

  const reset = useCallback(() => {
    setShowCommands(false);
    setCommandFilter("");
    setCommandHighlight(0);
  }, []);

  return {
    showCommands,
    setShowCommands,
    filteredCommands,
    commandHighlight,
    commandButtonRefs,
    onInputChange,
    handleKeyDown,
    reset,
  };
}
