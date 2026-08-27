import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { installIntersectionObserver, resetIntersectionObserver } from "./intersection-observer";

// JSDOM doesn't implement Web Animations API; base-ui ScrollArea calls this in async timers
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

// happy-dom's IntersectionObserver is a stub whose methods are all `// TODO: Implement`, so
// anything that mounts on intersection never mounts. Replace it unconditionally — the constructor
// exists, so no feature check can detect the difference.
installIntersectionObserver();

// The Tauri JS API reads these globals synchronously, so any component that constructs a window
// handle or registers an event listener throws in JSDOM without them. Individual suites still
// mock `@tauri-apps/api/core` for the IPC calls they assert on — this only keeps the plumbing
// from exploding in components that happen to be mounted.
if (!("__TAURI_INTERNALS__" in window)) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {
      metadata: { currentWindow: { label: "main" } },
      transformCallback: (callback: unknown) => callback,
      invoke: () => Promise.resolve(),
    },
    writable: true,
  });
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
    value: { unregisterListener: () => {} },
    writable: true,
  });
}

// Cleanup after each test
afterEach(() => {
  cleanup();
  resetIntersectionObserver();
});
