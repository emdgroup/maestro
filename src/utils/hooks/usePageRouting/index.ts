import { useState } from "react";

export type ViewType = "kanban" | "agents" | "worktrees" | "settings";

/**
 * Page order for determining slide direction
 */
const PAGE_ORDER: Record<ViewType, number> = {
  kanban: 0,
  agents: 1,
  worktrees: 2,
  settings: 3,
};

/**
 * Custom hook for managing page routing with slide animations
 * Handles active page state and calculates slide direction for transitions
 */
export function usePageRouting(initialPage: ViewType = "kanban") {
  const [activePage, setActivePage] = useState<ViewType>(initialPage);
  const [slideDirection, setSlideDirection] = useState(1);

  /**
   * Change the active page and calculate slide direction
   * Direction: 1 = moving right (forward), -1 = moving left (back)
   */
  const handlePageChange = (page: ViewType) => {
    if (page === activePage) return; // Don't animate if clicking same tab

    const currentIndex = PAGE_ORDER[activePage];
    const newIndex = PAGE_ORDER[page];
    const direction = newIndex > currentIndex ? 1 : -1;

    setSlideDirection(direction);
    setActivePage(page);
  };

  return {
    activePage,
    slideDirection,
    handlePageChange,
  };
}
