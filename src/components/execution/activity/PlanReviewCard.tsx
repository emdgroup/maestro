import { useCallback, useMemo } from "react";
import { Route, ChevronDown, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/ui/dropdown-menu";
import { useSessionAnnotations } from "@/store/annotationStore";
import {
  extractOptions,
  getAcceptMeta,
  isBypassOption,
  splitPermissionOptions,
} from "./permission-prompt-utils";
import { pickDefaultAccept, readLastAccept, writeLastAccept } from "./plan-accept-preference";
import type { PermissionOption } from "./permission-prompt-utils";
import type { ToolCallItem } from "./types";

/**
 * A plan the session has already settled, as a quiet row in the stream.
 *
 * The one still waiting is not rendered here — see `PendingPlanCard`, which takes the composer's
 * place at the bottom of the panel the way a permission request does.
 */
export function PlanReviewCard({ item }: { item: ToolCallItem }) {
  const isAccepted = item.status === "completed";
  return (
    <div className={cn("rounded-[10px] overflow-hidden", "border border-border bg-card/50")}>
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <div className="w-7 h-7 rounded-[7px] flex items-center justify-center shrink-0 border bg-muted/50 border-border">
          <Route className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-foreground/85">Plan</div>
          {item.title && (
            <div className="text-[10px] text-muted-foreground mt-0.5 truncate">{item.title}</div>
          )}
        </div>
        <span
          className={cn(
            "text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0",
            isAccepted ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
          )}
        >
          {isAccepted ? "Accepted" : "Rejected"}
        </span>
      </div>
    </div>
  );
}

/**
 * The live plan, in the slot the composer occupies when nothing is being asked — because that is
 * what this is: the agent asking to leave plan mode. The sheet around it comes from that slot,
 * shared with permission requests and elicitations; see `AgentBottomBar`.
 *
 * Every button comes from the payload's options, so an agent offering a different set — or
 * different names for the same set — needs no change here.
 */
export function PendingPlanCard({
  title,
  sessionKey,
  modelId,
  requestId,
  payload,
  onRespond,
  onOpen,
}: {
  /** The plan's own heading, from the tool call the request names. */
  title: string | null;
  sessionKey: number;
  /** The session's current model, which the remembered accept is keyed by. Null when unreported. */
  modelId: string | null;
  requestId: string;
  payload: Record<string, unknown>;
  onRespond: (requestId: string, optionId: string | null) => void;
  onOpen: () => void;
}) {
  const noteCount = useSessionAnnotations(sessionKey, "plan").length;
  const { acceptOptions, rejectOption } = splitPermissionOptions(extractOptions(payload));

  // Read once per model rather than per render. The card is keyed by request id, so it remounts
  // for the next plan and picks up whatever this one wrote.
  const lastAcceptId = useMemo(() => readLastAccept(modelId), [modelId]);
  const primary = pickDefaultAccept(acceptOptions, lastAcceptId);

  const respondAccept = useCallback(
    (optionId: string) => {
      writeLastAccept(modelId, optionId);
      onRespond(requestId, optionId);
    },
    [modelId, onRespond, requestId],
  );

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-[7px] bg-accent/10 border border-accent/30 flex items-center justify-center shrink-0">
          <Route className="w-4 h-4 text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-foreground">Plan ready for review</div>
          {title && (
            <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{title}</div>
          )}
        </div>
        {/* Status, not a control: the notes are acted on in the Plan tab, which is where the
            link beside this chip goes. */}
        {noteCount > 0 && (
          <span className="shrink-0 rounded-full border border-accent/30 bg-accent/15 px-1.75 py-0.5 text-[10px] font-semibold text-accent">
            {noteCount === 1 ? "1 note" : `${noteCount} notes`}
          </span>
        )}
        {/* A link, not a button: it goes somewhere rather than answering the request, and the two
            buttons that do answer it are in the row below. */}
        <Button variant="link" size="sm" className="shrink-0 px-1 text-accent" onClick={onOpen}>
          <ArrowUpRight className="size-3.5" />
          Review plan
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onRespond(requestId, rejectOption?.optionId ?? null)}
        >
          {rejectOption?.name ?? "Reject"}
        </Button>
        {primary ? (
          <ButtonGroup>
            <Button variant="accent" size="sm" onClick={() => respondAccept(primary.optionId)}>
              {primary.name}
            </Button>
            {acceptOptions.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="More accept options"
                  render={<Button variant="accent" size="sm" className="px-1.5!" />}
                >
                  <ChevronDown className="size-3.5" />
                </DropdownMenuTrigger>
                {/* Sized to its labels rather than to the icon button it anchors to, which would
                    wrap every one of them — same reason the canvas actions menu does it. */}
                <DropdownMenuContent align="end" className="w-auto whitespace-nowrap">
                  {acceptOptions.map((opt, i) => (
                    <AcceptMenuItem
                      key={opt.optionId}
                      option={opt}
                      // A bypass option is set apart rather than sitting flush against the
                      // ordinary ones, so it cannot be picked by momentum.
                      separated={isBypassOption(opt.optionId) && i > 0}
                      onSelect={() => respondAccept(opt.optionId)}
                    />
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </ButtonGroup>
        ) : (
          // No options at all: a legacy payload, answered the way `PermissionPrompt` answers one.
          <Button variant="accent" size="sm" onClick={() => onRespond(requestId, "allow")}>
            Allow
          </Button>
        )}
      </div>
    </div>
  );
}

function AcceptMenuItem({
  option,
  separated,
  onSelect,
}: {
  option: PermissionOption;
  separated: boolean;
  onSelect: () => void;
}) {
  const meta = getAcceptMeta(option);
  const bypass = isBypassOption(option.optionId);
  const Icon = meta.icon;
  return (
    <>
      {separated && <DropdownMenuSeparator />}
      <DropdownMenuItem className="gap-2.5" onClick={onSelect}>
        {/* `!` because the item recolours every descendant on focus, and a warning that stops
            warning exactly when the pointer is on it is no warning. */}
        <Icon className={cn("size-3.5", bypass ? "text-warning!" : "text-muted-foreground")} />
        <span className="flex flex-col">
          <span className={cn("text-xs font-medium leading-tight", bypass && "text-warning!")}>
            {option.name}
          </span>
          {meta.description && (
            <span className="text-[10px] leading-tight text-muted-foreground">
              {meta.description}
            </span>
          )}
        </span>
      </DropdownMenuItem>
    </>
  );
}
