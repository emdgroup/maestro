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

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Binary units, one decimal above bytes. Stops at TB, which no attachment or log will reach. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

export function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${count} ${count === 1 ? word : pluralWord}`;
}

/**
 * How long ago something happened, in the footer register: `5 min`, `3 h`, `2 d`, `3 w`. Callers
 * add the `ago` where the sentence wants one.
 *
 * Floored at a minute: `formatDistanceToNow` renders anything younger as "less than a minute ago",
 * which spends four words on the least informative case. A timestamp in the future (clock skew
 * between a remote host and this one) floors to the same place rather than reading "in 3 minutes"
 * about work that has already happened.
 */
export function relativeAge(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;

  const minutes = Math.max(1, Math.round((now - then) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d`;
  return `${Math.round(days / 7)} w`;
}

/** `15:00`, in the user's locale. */
export function formatTimeOfDay(at: TimeInput): string {
  return new Date(toEpoch(at)).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A ticking stopwatch: `4:07`, `61:01`. Takes milliseconds and never goes below `0:00`. */
export function formatElapsedCompact(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A countdown: `1d 4h`, `2h 05m`, `12m`, and seconds only in the last minute. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) {
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  }
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

/** How long something has been up, unpadded and in whole minutes: `3d 6h`, `4h 12m`, `9m`. */
export function formatUptime(startedAt: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** `4m 07s`, or `1h 04m` once the run passes an hour and the seconds stop mattering. */
export function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** `999`, `1.5K`, `106.9K`, `268M`. */
export function formatTokens(count: number): string {
  return compactNumber.format(count);
}

/**
 * `$142.18`, and whole units from a thousand up. A currency Intl does not know falls back to
 * `1.20 XYZ` rather than throwing.
 */
export function formatCost(amount: number, currency = "USD"): string {
  const digits = amount >= 1000 ? 0 : 2;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
