import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { cn } from "@/lib/utils";
import { usePreviewScheduleQuery } from "@/services/automation.service";
import { describeNextRun } from "../schedule";
import { describeExpression } from "./describe";
import { FIELD_DOCS } from "./docs";
import { FIELDS, isError, parseField } from "./fields";
import { SCHEDULE_TEMPLATES } from "./templates";

function tokensOf(cron: string): string[] {
  const written = cron.trim().split(/\s+/);
  return FIELDS.map((_, index) => written[index] ?? "*");
}

/**
 * A five-field cron expression, edited as five fields.
 *
 * There is no preset layer above this and nothing to map onto: the expression is the model, so
 * nothing snaps, nothing is ever read only, and an expression written by hand or by an agent is
 * edited in the same place as one picked from the menu.
 *
 * The three things around the slots each answer a different question. The sentence says what this
 * expression means, and is where the templates live because "what do I want" is answered in words
 * rather than in fields. The popover says what one slot may hold. `Next` says when it fires, and
 * comes from the daemon, which is the only thing here that parses cron to schedule anything.
 */
export function CronEditor({
  projectId,
  cron,
  timezone,
  onChange,
}: {
  projectId: number;
  cron: string;
  /** The zone the expression is read in. Only shown, never chosen here. */
  timezone: string;
  onChange: (cron: string) => void;
}) {
  const [focused, setFocused] = useState<number | null>(null);
  const tokens = tokensOf(cron);
  const reading = describeExpression(cron);
  const broken = "error" in reading;

  // Asked only for an expression that parses here first, so a half-typed field is not a round trip.
  const { data: next } = usePreviewScheduleQuery(projectId, broken ? null : cron, timezone);

  const focusedField = (() => {
    if (focused === null) return null;
    const spec = FIELDS[focused];
    const result = parseField(tokens[focused], spec);
    return { doc: FIELD_DOCS[spec.kind], error: isError(result) ? result.error : null };
  })();

  function write(index: number, token: string) {
    const written = [...tokens];
    written[index] = token;
    onChange(written.join(" "));
  }

  /** A whole expression dropped into any one slot fills all five, as an OTP field takes a code. */
  function paste(event: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text").trim();
    const parts = pasted.split(/\s+/);
    if (parts.length !== FIELDS.length) return;
    event.preventDefault();
    onChange(parts.join(" "));
  }

  return (
    <div className="space-y-2">
      <Popover>
        <PopoverTrigger
          className={cn(
            "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors",
            broken
              ? "border-destructive/40 bg-destructive/5 text-destructive"
              : "border-border bg-muted/30 hover:bg-muted/50",
          )}
        >
          <span className="flex-1 text-xs">
            {"error" in reading ? reading.error : reading.text}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        {/* Open from the error too: picking a template overwrites the field that is wrong, which
            makes a schedule that cannot be read a way out rather than a dead end. */}
        <PopoverContent align="start" className="w-80 gap-0 p-1">
          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            Start from
          </p>
          {SCHEDULE_TEMPLATES.map((template) => {
            const reading = describeExpression(template);
            return (
              <button
                key={template}
                type="button"
                onClick={() => onChange(template)}
                className={cn(
                  "rounded px-2 py-1.5 text-left text-xs hover:bg-muted",
                  template === cron.trim() && "bg-muted",
                )}
              >
                {"error" in reading ? template : reading.text}
              </button>
            );
          })}
        </PopoverContent>
      </Popover>

      {/* `relative` on the row rather than on a slot: the popover is as wide as the whole control
          and in the same place whichever field has focus, so reading one field after another does
          not move the panel under the cursor. */}
      <div className="relative flex items-start gap-1.5">
        {FIELDS.map((spec, index) => {
          const result = parseField(tokens[index], spec);
          const wrong = isError(result);
          return (
            <div key={spec.kind} className="flex-1 space-y-1">
              <input
                value={tokens[index]}
                onChange={(event) => write(index, event.target.value)}
                onPaste={paste}
                onFocus={() => setFocused(index)}
                onBlur={() => setFocused((open) => (open === index ? null : open))}
                aria-label={spec.label}
                spellCheck={false}
                className={cn(
                  "h-10 w-full rounded-md border bg-background text-center font-mono text-sm outline-none",
                  wrong
                    ? "border-2 border-destructive bg-destructive/5"
                    : focused === index
                      ? "border-2 border-primary"
                      : "border-border",
                )}
              />
              <div
                className={cn(
                  "text-center text-[9.5px]",
                  wrong
                    ? "text-destructive"
                    : focused === index
                      ? "font-medium text-primary"
                      : "text-muted-foreground",
                )}
              >
                {spec.label}
              </div>
            </div>
          );
        })}

        {/* Hand-placed rather than a popover component: it follows focus rather than a click, and
            must not take focus away from the field it is describing. */}
        {focusedField && (
          <div className="absolute inset-x-0 top-14 z-20 space-y-2 rounded-md border border-border bg-popover p-3 shadow-lg">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium">{focusedField.doc.title}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                {focusedField.doc.range}
              </span>
            </div>
            {/* Two columns of token-and-meaning pairs, each pair a grid of its own so every
                meaning starts at the same x whatever the token beside it is. */}
            <div className="grid grid-cols-2 gap-x-5 gap-y-1">
              {focusedField.doc.examples.map((example) => (
                <div
                  key={example.token}
                  className="grid grid-cols-[4.5rem_1fr] items-baseline gap-x-2 text-[10.5px]"
                >
                  <span className="truncate font-mono text-foreground">{example.token}</span>
                  <span className="text-muted-foreground">{example.meaning}</span>
                </div>
              ))}
            </div>
            {focusedField.doc.caution && (
              <p className="border-t border-border pt-2 text-[10.5px] text-muted-foreground">
                {focusedField.doc.caution}
              </p>
            )}
            {focusedField.error && (
              <p className="text-[10.5px] text-destructive">{focusedField.error}</p>
            )}
          </div>
        )}
      </div>

      {/* Left empty rather than stale while a field is wrong: there is no answer to give. */}
      <div className="flex items-baseline gap-2 rounded-md bg-muted/40 px-2.5 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Next
        </span>
        <span className="text-xs">
          {broken ? (
            <span className="text-muted-foreground">nothing while a field is wrong</span>
          ) : next ? (
            describeNextRun(new Date(next), new Date())
          ) : next === null ? (
            <span className="text-muted-foreground">never, as written</span>
          ) : (
            <span className="text-muted-foreground">working it out</span>
          )}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">{timezone}</span>
      </div>
    </div>
  );
}
