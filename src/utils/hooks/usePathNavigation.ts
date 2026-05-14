import { useState, useRef } from "react";

const DRIVES_ROOT = "<<DRIVES>>";

export function usePathNavigation(isLocal: boolean, drives: string[]) {
  const [currentPath, setCurrentPath] = useState<string>("");

  // Use ref to avoid resetting state when drives change
  const drivesRef = useRef<string[]>(drives);
  drivesRef.current = drives;

  const navigateToDirectory = (dirName: string) => {
    // Handle drive selection on Windows
    if (currentPath === DRIVES_ROOT) {
      setCurrentPath(dirName);
      return;
    }

    // Handle normal directory navigation
    let newPath: string;

    // Check if current path is a drive root (e.g., "C:/")
    if (/^[A-Z]:\/$/i.test(currentPath)) {
      newPath = `${currentPath}${dirName}`;
    } else if (currentPath === "/") {
      newPath = `/${dirName}`;
    } else {
      newPath = `${currentPath}/${dirName}`;
    }

    setCurrentPath(newPath);
  };

  const navigateToParent = () => {
    // Special case: at drives root, can't go up
    if (currentPath === DRIVES_ROOT) {
      return;
    }

    // Check if we're at a drive root on Windows (e.g., "C:/")
    if (isLocal && drivesRef.current.length > 0 && /^[A-Z]:\/$/i.test(currentPath)) {
      // Go back to drives list
      setCurrentPath(DRIVES_ROOT);
      return;
    }

    // Unix-style or nested Windows path
    const parts = currentPath.split("/").filter(Boolean);
    if (parts.length > 0) {
      parts.pop();

      // Check if after popping, we have a drive letter (e.g., ["C:"])
      if (parts.length === 1 && /^[A-Z]:$/i.test(parts[0])) {
        setCurrentPath(`${parts[0]}/`);
      } else if (parts.length === 0) {
        // No parts left, go to root
        setCurrentPath("/");
      } else {
        // Check if first part is a Windows drive letter
        const isWindowsPath = /^[A-Z]:$/i.test(parts[0]);
        const newPath = isWindowsPath ? parts.join("/") : "/" + parts.join("/");
        setCurrentPath(newPath);
      }
    }
  };

  const navigateToBreadcrumb = (index: number) => {
    if (index === -1) {
      // Root click - on Windows with drives, go to drives root
      if (isLocal && drivesRef.current.length > 0) {
        setCurrentPath(DRIVES_ROOT);
      } else {
        setCurrentPath("/");
      }
      return;
    }

    const parts = currentPath.split("/").filter(Boolean);
    const selectedPart = parts.slice(0, index + 1);

    // Check if we're clicking on a drive letter
    if (selectedPart.length === 1 && /^[A-Z]:$/i.test(selectedPart[0])) {
      setCurrentPath(`${selectedPart[0]}/`);
    } else {
      // Check if first part is a Windows drive letter
      const isWindowsPath = /^[A-Z]:$/i.test(selectedPart[0]);
      const newPath = isWindowsPath ? selectedPart.join("/") : "/" + selectedPart.join("/");
      setCurrentPath(newPath);
    }
  };

  // Parse path into breadcrumb parts
  const pathParts = currentPath === DRIVES_ROOT ? [] : currentPath.split("/").filter(Boolean);

  const isDrivesRoot = isLocal && currentPath === DRIVES_ROOT;

  return {
    currentPath,
    setCurrentPath,
    pathParts,
    isDrivesRoot,
    navigateToDirectory,
    navigateToParent,
    navigateToBreadcrumb,
  };
}
