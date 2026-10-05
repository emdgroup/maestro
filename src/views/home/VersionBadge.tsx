import { useEffect, useState } from "react";
import { CircleFadingArrowUp, LoaderCircle } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { useUpdater } from "@/hooks/useUpdater";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { UpdateCard } from "@/components/settings/UpdateCard";

/** The app's version bottom-right, opening the update card. */
export function VersionBadge() {
  const [appVersion, setAppVersion] = useState("…");
  const { status } = useUpdater();
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  const icon =
    status.phase === "available" ? (
      <span className="relative flex items-center justify-center">
        <span className="absolute -inset-1 rounded-full bg-accent/50 animate-ping" />
        <CircleFadingArrowUp className="w-3.5 h-3.5 relative text-accent" />
      </span>
    ) : status.phase === "downloading" ? (
      <LoaderCircle className="w-3.5 h-3.5 animate-spin text-accent" />
    ) : null;

  return (
    <Popover>
      <PopoverTrigger className="absolute bottom-4 right-4 flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer border border-transparent hover:border-border/50">
        {icon}v{appVersion}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-fit p-3">
        <UpdateCard />
      </PopoverContent>
    </Popover>
  );
}
