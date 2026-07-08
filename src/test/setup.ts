import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// JSDOM doesn't implement Web Animations API; base-ui ScrollArea calls this in async timers
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

// Cleanup after each test
afterEach(() => {
  cleanup();
});
