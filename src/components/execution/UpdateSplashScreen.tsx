import maestroLogoUrl from "../../../src-tauri/icons/32x32.png?url";

type UpdateStatus =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "upToDate" }
  | { phase: "available"; version: string; notes: string | null }
  | { phase: "downloading"; progress: number; version: string }
  | { phase: "error"; message: string };

type StepState = "pending" | "active" | "done";

function stepColor(state: StepState): string {
  if (state === "pending") return "text-muted-foreground/50";
  if (state === "done") return "text-muted-foreground";
  return "text-foreground";
}

function StepBullet({ state }: { state: StepState }) {
  return (
    <div
      className={`w-[22px] h-[22px] rounded-full border flex items-center justify-center shrink-0 text-[11px] transition-colors ${
        state === "active"
          ? "border-primary/60 bg-primary/10"
          : state === "done"
            ? "border-green-500/60 bg-green-500/10 text-green-500"
            : "border-border"
      }`}
    >
      {state === "active" && (
        <span className="w-[11px] h-[11px] rounded-full border-[1.5px] border-primary/20 border-t-primary animate-spin block" />
      )}
      {state === "done" && "✓"}
    </div>
  );
}

export function UpdateSplashScreen({ status }: { status: UpdateStatus }) {
  const isDownloading = status.phase === "downloading";
  const progress = isDownloading ? status.progress : 0;
  const version = isDownloading ? status.version : null;

  const step1: StepState = isDownloading ? "done" : "active";
  const step2: StepState = isDownloading ? "active" : "pending";
  const step3: StepState = "pending";

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background gap-9">
      {/* Logo */}
      <div className="flex flex-col items-center gap-3.5">
        <img src={maestroLogoUrl} alt="Maestro" className="w-16 h-16 rounded-2xl" />
        <span className="text-[22px] font-semibold tracking-tight">Maestro</span>
        {version && (
          <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full bg-card border border-border text-muted-foreground">
            v{version}
          </span>
        )}
      </div>

      {/* Steps */}
      <div className="flex flex-col gap-3.5 w-[280px]">
        <div className={`flex items-center gap-3 text-[13px] ${stepColor(step1)}`}>
          <StepBullet state={step1} />
          <span>{isDownloading ? `Update v${version} found` : "Checking for updates"}</span>
        </div>
        <div className={`flex items-center gap-3 text-[13px] ${stepColor(step2)}`}>
          <StepBullet state={step2} />
          <span>Downloading update</span>
        </div>
        <div className={`flex items-center gap-3 text-[13px] ${stepColor(step3)}`}>
          <StepBullet state={step3} />
          <span>Installing &amp; restarting</span>
        </div>
      </div>

      {/* Progress bar */}
      {isDownloading && (
        <div className="w-[280px] flex flex-col gap-1.5">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Downloading…</span>
            <span>{progress}%</span>
          </div>
          <div className="h-[3px] bg-border rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <p className="text-[11.5px] text-muted-foreground/50">Please wait…</p>
    </div>
  );
}
