import * as React from "react";

const MOBILE_BREAKPOINT = 768;

const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

/**
 * The viewport width is external state, so it is read through `useSyncExternalStore`
 * rather than mirrored into `useState` from an effect. That also removes the
 * `undefined` first render the mirrored version produced, which reported every
 * viewport as desktop until the effect ran.
 */
export function useIsMobile(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot);
}
