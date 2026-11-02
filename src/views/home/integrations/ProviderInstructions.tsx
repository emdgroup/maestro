import { cn } from "@/lib/utils";
import { useState } from "react";
import { Reveal } from "@/components/common/Reveal";
import { ChevronDown } from "lucide-react";
import { getProviderInstructions, BITBUCKET_INSTRUCTIONS } from "./integration-provider-config";

export function ProviderInstructions({
  provider,
  bitbucketMode,
}: {
  provider: string;
  bitbucketMode?: "cloud" | "server";
}) {
  const [open, setOpen] = useState(false);

  const instructions =
    provider === "bitbucket" && bitbucketMode
      ? BITBUCKET_INSTRUCTIONS[bitbucketMode]
      : getProviderInstructions(provider);

  if (!instructions) return null;

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDown
          className={cn("w-3 h-3 transition-transform duration-200", open && "rotate-180")}
        />
        Instructions to get token
      </button>
      <Reveal open={open}>
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <ol className="space-y-1.5 text-xs text-muted-foreground list-decimal list-inside">
            {instructions.map((line, i) =>
              line.code ? (
                <li
                  key={i}
                  className="font-mono text-foreground bg-muted rounded px-1.5 py-0.5 list-none ml-4"
                >
                  {line.text}
                </li>
              ) : (
                <li key={i} className="leading-relaxed">
                  {line.text}
                </li>
              ),
            )}
          </ol>
        </div>
      </Reveal>
    </div>
  );
}
