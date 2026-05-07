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
