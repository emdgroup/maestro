import { format, formatDistance } from "date-fns";

/** Anything a backend row hands over as a time: an epoch, an ISO string, or an actual `Date`. */
type TimeInput = number | string | Date;

function toEpoch(value: TimeInput): number {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  return Date.parse(value);
}

/**
 * How long ago, in the compact register the card chrome uses: `just now`, `12m ago`, `5h ago`,
 * then an absolute `Mar 4` once counting hours stops being a useful way to say it.
 *
 * `now` is a parameter rather than a `Date.now()` inside, so a caller driving this from a shared
 * clock gets a label derived from the value it rendered with. `MessageActionBar` needs that: its
 * clock lives in a store read through `useSyncExternalStore`, and reading the real clock here
 * instead would go behind React's back and freeze the label on its first value.
 *
 * An unparseable input gives `""` — these come off backend rows, and a row with a bad timestamp
 * should lose its subtitle rather than render `Invalid Date`.
 */
export function formatTimeAgoCompact(at: TimeInput, now: number = Date.now()): string {
  const epoch = toEpoch(at);
  if (!Number.isFinite(epoch)) return "";
  const minutes = Math.floor((now - epoch) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return format(epoch, "MMM d");
}

/**
 * The same fact in the prose register — `about 3 hours ago` — for rows with space for a sentence.
 *
 * Under a minute is `just now` rather than date-fns's `less than a minute ago`, which is a lot of
 * words for the most common case.
 */
export function formatTimeAgoLong(at: TimeInput, now: number = Date.now()): string {
  const epoch = toEpoch(at);
  if (!Number.isFinite(epoch)) return "";
  if (now - epoch < 60_000) return "just now";
  return formatDistance(epoch, now, { addSuffix: true });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function humanizeTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) {
    const k = Math.floor(count / 1000);
    const h = Math.round((count % 1000) / 100);
    return h === 0 ? `${k}k` : h === 10 ? `${k + 1}k` : `${k}.${h}k`;
  }
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) {
    const m = Math.floor(count / 1_000_000);
    const h = Math.round((count % 1_000_000) / 100_000);
    return h === 0 ? `${m}M` : h === 10 ? `${m + 1}M` : `${m}.${h}M`;
  }
  return `${Math.round(count / 1_000_000)}M`;
}
