import { useEffect, useRef } from "react";

/**
 * A ref that holds `value` as of the last commit, for a callback that runs later (an event, a
 * timer, a poll) and must see the current value rather than the one its closure captured.
 * Written from an effect, not during render, so it never shows a render that did not commit.
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
