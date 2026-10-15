import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { installIntersectionObserver, resetIntersectionObserver } from "./intersection-observer";

// user-event's default `delay: 0` still awaits a `setTimeout` after every pointer step and every
// key, and on Windows that is a whole ~15ms timer tick: typing a sentence cost a third of a second
// in waits alone. `delay: null` skips the wait. A suite that wants a real delay can still pass one.
vi.mock("@testing-library/user-event", async (importOriginal) => {
  const { userEvent } = await importOriginal<typeof import("@testing-library/user-event")>();
  const setup: typeof userEvent.setup = (options) => userEvent.setup({ delay: null, ...options });
  // The direct API (`userEvent.click(el)`) sets up a fresh instance per call, as this does.
  const direct = Object.fromEntries(
    Object.keys(userEvent)
      .filter((name) => name !== "setup")
      .map((name) => [
        name,
        (...args: unknown[]) =>
          (setup() as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args),
      ]),
  );
  const fast = { ...direct, setup } as typeof userEvent;
  return { default: fast, userEvent: fast };
});

// The real highlighter loads grammars in the background the first time anything renders code or a
// diff, and whichever test was still going when they landed absorbed the work, a different one each
// time. Nothing but its own suite asserts on highlighting, and that suite unmocks it.
vi.mock("@/lib/diff-highlighter", () => ({
  getDiffHighlighter: () => new Promise(() => {}),
  highlightToHtml: () => new Promise(() => {}),
}));

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
