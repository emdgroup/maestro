import { useState, useRef, useEffect } from "react";

interface UseKeyboardNavigationReturn {
  selectedIndex: number;
  setSelectedIndex: (index: number | ((prev: number) => number)) => void;
  directoryButtonRefs: React.MutableRefObject<Map<number, HTMLButtonElement>>;
}

export function useKeyboardNavigation(): UseKeyboardNavigationReturn {
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const directoryButtonRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex >= 0) {
      const button = directoryButtonRefs.current.get(selectedIndex);
      if (button) {
        button.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }, [selectedIndex]);

  return {
    selectedIndex,
    setSelectedIndex,
    directoryButtonRefs,
  };
}
