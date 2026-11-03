import { useMemo } from "react";
import { groupToolCalls, groupIntoAgentSections, mergeLiveItems } from "../activity/utils";
import type { ActivityItem, UserMessageItem } from "../activity/types";
import { getItemKey } from "./AgentStreamContent";

/** The stream as the panel draws it: live items with the answered requests merged in, in sections. */
export function useStreamSections(
  items: ActivityItem[],
  permissionResponses: Parameters<typeof mergeLiveItems>[1],
  elicitationSummaries: Parameters<typeof mergeLiveItems>[2],
) {
  const displayItems = useMemo(
    () => mergeLiveItems(items, permissionResponses, elicitationSummaries),
    [items, permissionResponses, elicitationSummaries],
  );
  const agentSections = useMemo(
    () => groupIntoAgentSections(groupToolCalls(displayItems)),
    [displayItems],
  );

  /*
    Four consumers wanted four different views of the same list, and each used to walk it
    separately. One pass, since they all key off the same "is this a standalone user message"
    test: a readability win rather than a speed one; the memo already meant none of the four
    re-ran unless the sections changed.
  */
  const { userMessages, orderedSectionIds, userMessageCount } = useMemo(() => {
    const msgs: UserMessageItem[] = [];
    const ids: string[] = [];
    let standalones = 0;
    for (const section of agentSections) {
      if (section.type === "standalone") {
        standalones++;
        const gi = section.item;
        if (gi.type === "solo" && gi.item.type === "userMessage") {
          msgs.push(gi.item.item);
          ids.push(gi.item.item.id);
        }
      } else {
        ids.push(getItemKey(section.items[0]));
      }
    }
    return { userMessages: msgs, orderedSectionIds: ids, userMessageCount: standalones };
  }, [agentSections]);

  // Not wrapped in useMemo: the result is a string compared by value, and the compiler
  // memoizes this itself.
  let lastAgentSectionId: string | null = null;
  for (let i = agentSections.length - 1; i >= 0; i--) {
    const s = agentSections[i];
    if (s.type === "agentSection") {
      lastAgentSectionId = getItemKey(s.items[0]);
      break;
    }
  }

  return {
    displayItems,
    agentSections,
    userMessages,
    orderedSectionIds,
    userMessageCount,
    lastUserMessage: userMessages.length > 0 ? userMessages[userMessages.length - 1] : null,
    lastAgentSectionId,
  };
}
