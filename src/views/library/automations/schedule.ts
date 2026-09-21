import type { Automation, AutomationSchedule } from "@/types/bindings";

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** `HH:MM` as hours and minutes, or midnight when the string is not one. */
function parseTime(time: string): [number, number] {
  const [hours, minutes] = time.split(":").map(Number);
  return [Number.isFinite(hours) ? hours : 0, Number.isFinite(minutes) ? minutes : 0];
}

function allowedDay(schedule: AutomationSchedule, date: Date): boolean {
  const day = date.getDay();
  if (schedule.kind === "Weekdays") return day >= 1 && day <= 5;
  if (schedule.kind === "Weekly") return day === (schedule.weekday ?? 1);
  return true;
}

/**
 * The next time this schedule comes round, strictly after `after`, in the machine's local time.
 *
 * Strictly after is what stops a tick that lands exactly on the minute from firing the same
 * occurrence twice: the run's own time becomes the floor for the next one.
 */
export function nextRun(schedule: AutomationSchedule, after: Date): Date {
  const [hours, minutes] = parseTime(schedule.time);
  const candidate = new Date(after);
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate <= after) candidate.setDate(candidate.getDate() + 1);
  // At most a week away for every kind there is, so the walk is bounded rather than a while(true).
  for (let i = 0; i < 7 && !allowedDay(schedule, candidate); i++) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

/**
 * Whether the clock should fire this automation now, given when it last did.
 *
 * `since` is the floor: the last fire, or when the app opened, whichever is later. Because
 * `nextRun` is strictly after that floor, claiming a fire by moving the floor to now is what makes
 * a second tick in the same minute a no-op.
 */
export function isDue(automation: Automation, since: number, now: number): boolean {
  if (!automation.enabled || !automation.schedule) return false;
  return nextRun(automation.schedule, new Date(since)).getTime() <= now;
}

/** "Daily at 09:00", for the row and for the editor's summary. */
export function describeSchedule(schedule: AutomationSchedule | null | undefined): string {
  if (!schedule) return "Manual only";
  if (schedule.kind === "Daily") return `Daily at ${schedule.time}`;
  if (schedule.kind === "Weekdays") return `Weekdays at ${schedule.time}`;
  return `${WEEKDAY_NAMES[schedule.weekday ?? 1]}s at ${schedule.time}`;
}

/** "today at 09:00", "tomorrow at 09:00", "Monday at 09:00". */
export function describeNextRun(next: Date, now: Date): string {
  const time = next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const days = Math.round(
    (new Date(next).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `${WEEKDAY_NAMES[next.getDay()]} at ${time}`;
}
