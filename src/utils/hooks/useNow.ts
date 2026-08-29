import { useEffect, useState } from "react";

/**
 * The current time, re-read on an interval.
 *
 * A relative label like "3 min" is computed at render, so without something to re-render it the
 * text freezes at whatever it said when the component mounted — which is why the worktree cards
 * kept reporting the same age even after a refresh: the query returned identical data, React had
 * no reason to re-render, and the clock the label depends on is not React state.
 *
 * Call this once per list rather than once per row: one interval driving a parent is a single
 * timer, where a hook per card is one timer per card all firing at slightly different moments.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
