import { memo, useState, useEffect } from "react";
import { formatElapsedCompact, formatTimeAgoCompact } from "@/lib/format-utils";
import type { SessionActivityStatus } from "@/store/sessionActivityStore";

export const ElapsedTime = memo(function ElapsedTime({
  status,
  stateChangedAt,
}: {
  status: SessionActivityStatus;
  stateChangedAt: number;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="text-[10px] font-mono text-muted-foreground/60 shrink-0 whitespace-nowrap">
      {status === "idle"
        ? formatTimeAgoCompact(stateChangedAt, now)
        : formatElapsedCompact(now - stateChangedAt)}
    </span>
  );
});
