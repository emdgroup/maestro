import { useState, useRef, useCallback, useEffect } from "react";
import { api } from "@/lib/tauri-utils";
import type { MentionEntry } from "./mentionEntry";

interface Params {
  logId: number | null | undefined;
}

export function useMentionAutocomplete({ logId }: Params) {
  const [mentions, setMentions] = useState<MentionEntry[]>([]);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionSuggestions, setMentionSuggestions] = useState<string[]>([]);
  const [mentionHighlight, setMentionHighlight] = useState(0);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionTriggerOffset, setMentionTriggerOffset] = useState(0);
  const mentionSearchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mentionButtonRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  useEffect(() => {
    if (!showMentions || !logId) return;
    if (mentionSearchRef.current) clearTimeout(mentionSearchRef.current);
    mentionSearchRef.current = setTimeout(async () => {
      try {
        const results = await api.searchSessionFiles(logId, mentionQuery, 20);
        setMentionSuggestions(results);
        setMentionHighlight(0);
      } catch {
        setMentionSuggestions([]);
      }
    }, 120);
    return () => {
      if (mentionSearchRef.current) clearTimeout(mentionSearchRef.current);
    };
  }, [showMentions, mentionQuery, logId]);

  useEffect(() => {
    const button = mentionButtonRefs.current.get(mentionHighlight);
    if (button) button.scrollIntoView({ block: "nearest" });
  }, [mentionHighlight]);

  const closeMentions = useCallback(() => {
    setShowMentions(false);
    setMentionSuggestions([]);
    setMentionQuery("");
  }, []);

  const onMentionSelected = useCallback(
    (newMention: MentionEntry) => {
      setMentions((prev) => [...prev, newMention]);
      closeMentions();
    },
    [closeMentions],
  );

  // Detects @ trigger in input and updates state
  const onInputChange = useCallback(
    (value: string, cursor: number) => {
      const textToCursor = value.slice(0, cursor);
      const atMatch = textToCursor.match(/(?:^|[\s\n])(@)([^\s]*)$/);
      if (atMatch && logId) {
        const triggerPos = textToCursor.lastIndexOf("@");
        const query = atMatch[2];
        setMentionTriggerOffset(triggerPos);
        setMentionQuery(query);
        setShowMentions(true);
      } else {
        closeMentions();
      }
    },
    [logId, closeMentions],
  );

  // Returns true if the event was consumed
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, onSelectMention: (filePath: string) => void): boolean => {
      if (!showMentions || mentionSuggestions.length === 0) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionHighlight((i) => (i + 1) % mentionSuggestions.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionHighlight((i) => (i - 1 + mentionSuggestions.length) % mentionSuggestions.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (mentionSuggestions[mentionHighlight]) {
          onSelectMention(mentionSuggestions[mentionHighlight]);
        }
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMentions();
        return true;
      }
      return false;
    },
    [showMentions, mentionSuggestions, mentionHighlight, closeMentions],
  );

  const reset = useCallback(() => {
    setMentions([]);
    closeMentions();
  }, [closeMentions]);

  return {
    mentions,
    setMentions,
    showMentions,
    mentionSuggestions,
    mentionHighlight,
    mentionTriggerOffset,
    mentionButtonRefs,
    closeMentions,
    onMentionSelected,
    onInputChange,
    handleKeyDown,
    reset,
  };
}
