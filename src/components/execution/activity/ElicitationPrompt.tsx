import { useState, type ReactNode } from "react";
import {
  MessageCircleQuestionMark,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Check,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { parseElicitationFields } from "./elicitation-utils";
import type { ElicitationField } from "./elicitation-utils";

export { parseElicitationFields };
export type { ElicitationField };

interface ElicitationPromptProps {
  requestId: string;
  message: string;
  fields: ElicitationField[];
  otherField: { key: string; title?: string; description?: string } | null;
  onSubmit: (requestId: string, values: Record<string, unknown>) => void;
  onDecline: (requestId: string) => void;
}

function isSingleSelect(field: ElicitationField): boolean {
  return field.type === "string" && !!(field.oneOf || field.enumValues);
}

function isMultiSelect(field: ElicitationField): boolean {
  return field.type === "array";
}

// Rows carry no border of their own: a bordered box per option was too much chrome for a card
// this small. The fill and the dividers fade out at both sides instead, so a row that spans the
// card has no hard edge where it meets the sheet's.
const optionShell = (selected: boolean) =>
  cn(
    "flex gap-2 cursor-pointer transition-colors text-sm",
    selected
      ? "text-foreground bg-[linear-gradient(to_right,transparent,color-mix(in_oklab,var(--accent)_14%,transparent)_12%,color-mix(in_oklab,var(--accent)_14%,transparent)_88%,transparent)]"
      : "text-muted-foreground hover:bg-[linear-gradient(to_right,transparent,color-mix(in_oklab,var(--muted)_55%,transparent)_12%,color-mix(in_oklab,var(--muted)_55%,transparent)_88%,transparent)]",
  );

// A hairline between options, faded like the fill. `border-image` rather than `divide-y`, which
// can only draw a solid colour.
const optionList =
  "[&>*+*]:border-t [&>*+*]:[border-image:linear-gradient(to_right,transparent,var(--border)_15%,var(--border)_85%,transparent)_1]";

function OptionGlyph({ type, selected }: { type: "radio" | "checkbox"; selected: boolean }) {
  return (
    <div
      className={cn(
        "w-4 h-4 border-2 flex items-center justify-center shrink-0 transition-all",
        type === "radio" ? "rounded-full" : "rounded",
        selected ? "border-accent bg-accent" : "border-muted-foreground/40",
      )}
    >
      {selected &&
        (type === "radio" ? (
          <div className="w-1.5 h-1.5 rounded-full bg-primary-foreground" />
        ) : (
          <Check className="w-2.5 h-2.5 text-primary-foreground" />
        ))}
    </div>
  );
}

// One option row. Radio and checkbox differ only in the control glyph, so "Other" can be the
// same row as every other choice — which is the point: it has to look like it belongs to the
// group, or the user cannot tell whether picking it replaces or adds to their selection.
function OptionRow({
  type,
  name,
  selected,
  onSelect,
  children,
}: {
  type: "radio" | "checkbox";
  name?: string;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <label className={cn(optionShell(selected), "items-center px-2.5 py-1.5")}>
      <input type={type} name={name} className="sr-only" checked={selected} onChange={onSelect} />
      <OptionGlyph type={type} selected={selected} />
      {children}
    </label>
  );
}

// "Other" is one option whose body happens to be a text box: same shell, same glyph, and the box
// inside it rather than under it, so putting the caret in it is picking the option. No separator
// setting it apart — it is a member of the list, not an aside — and the box stays mounted whether or not
// it is picked, since revealing it on demand would move every control below it.
function OtherOption({
  label,
  description,
  type,
  name,
  checked,
  setChecked,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  type: "radio" | "checkbox";
  name?: string;
  checked: boolean;
  setChecked: (checked: boolean) => void;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div
      className={cn(optionShell(checked), "items-start px-2.5 py-2")}
      // Toggles from anywhere but the box — inside it, focus does the picking, so a click there
      // must not immediately undo it.
      onClick={(e) => {
        if ((e.target as HTMLElement).tagName !== "TEXTAREA") setChecked(!checked);
      }}
    >
      <input
        type={type}
        name={name}
        className="sr-only"
        checked={checked}
        onChange={() => setChecked(!checked)}
      />
      <div className="mt-0.5">
        <OptionGlyph type={type} selected={checked} />
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        <div>{label}</div>
        <Textarea
          value={value}
          onFocus={() => setChecked(true)}
          onChange={(e) => {
            onChange(e.target.value);
            if (!checked) setChecked(true);
          }}
          className="min-h-15 bg-background/60 border-border focus-visible:border-accent/50 focus-visible:ring-0 text-sm"
          // The description is the prompt for what to type, so it is the placeholder rather than
          // a line of its own — one less row in a card that already scrolls.
          placeholder={description ?? "Type here…"}
        />
      </div>
    </div>
  );
}

export function ElicitationPrompt({
  requestId,
  message,
  fields,
  otherField,
  onSubmit,
  onDecline,
}: ElicitationPromptProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [otherValues, setOtherValues] = useState<Record<string, string>>({});
  // Whether "Other" is the picked option for this field, tracked separately from its text: a
  // checked-but-empty Other is a deliberate state the user can see, not an unanswered field.
  const [otherChecked, setOtherChecked] = useState<Record<string, boolean>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [direction, setDirection] = useState(1);
  // Open on arrival — the agent is blocked on this. Collapsing is the user's own move, to give the
  // conversation above the panel back its room while they read it.
  const [collapsed, setCollapsed] = useState(false);

  const isMultiField = fields.length > 1;
  const currentField = fields[currentIndex] ?? null;

  const set = (key: string, value: unknown) => setValues((prev) => ({ ...prev, [key]: value }));

  const isAnswered = (field: ElicitationField): boolean => {
    if (otherChecked[field.key]) {
      if (otherValues[field.key]?.trim()) return true;
      // Other is the only answer a single-select can hold, so an empty box leaves it unanswered.
      if (isSingleSelect(field)) return false;
    }
    const val = values[field.key];
    if (field.type === "boolean") return val !== undefined;
    if (val === undefined || val === null || val === "") return false;
    if (Array.isArray(val)) return val.length > 0;
    return true;
  };

  const unansweredCount = fields.filter((f) => !isAnswered(f)).length;

  const resolvedValues = (): Record<string, unknown> => {
    const result = { ...values };
    for (const field of fields) {
      if (!otherChecked[field.key]) continue;
      const ov = otherValues[field.key]?.trim();
      if (!ov) continue;
      if (isSingleSelect(field)) {
        result[field.key] = ov;
      } else if (isMultiSelect(field)) {
        const cur = (result[field.key] as string[]) ?? [];
        result[field.key] = [...cur, ov];
      }
    }
    if (otherField?.key) delete result[otherField.key];
    return result;
  };

  const goTo = (index: number) => {
    setDirection(index > currentIndex ? 1 : -1);
    setCurrentIndex(index);
    // The dots stay in the collapsed header, so picking one is also how you reopen the card.
    setCollapsed(false);
  };

  // single-select is unambiguous — advance for the user, after a beat so the pick is visible
  const advanceAfterPick = () => {
    if (currentIndex >= fields.length - 1) return;
    const next = currentIndex + 1;
    setTimeout(() => {
      setDirection(1);
      setCurrentIndex(next);
    }, 200);
  };

  const handleSubmit = () => {
    if (unansweredCount > 0 && !submitAttempted) {
      setSubmitAttempted(true);
      return;
    }
    onSubmit(requestId, resolvedValues());
  };

  const singleSelectOptions = currentField
    ? isSingleSelect(currentField)
      ? (currentField.oneOf ?? currentField.enumValues?.map((v) => ({ const: v, title: v })) ?? [])
      : []
    : [];

  const multiSelectOptions = currentField
    ? isMultiSelect(currentField)
      ? (currentField.items?.anyOf ??
        currentField.items?.enum?.map((v) => ({ const: v, title: v })) ??
        [])
      : []
    : [];

  const showOtherInput = otherField !== null;
  // The parser falls back to the request's own message when a field carries no description, so
  // drop it here rather than printing the card's title a second time under "Other".
  const otherDescription =
    otherField?.description === message ? undefined : otherField?.description;

  return (
    // The sheet around this comes from the slot it renders in — see `AgentBottomBar`.
    <div className="flex flex-col gap-2">
      {/* Header — the same tile and title a permission request or a plan carries, plus the progress
          dots and the collapse toggle. It is the whole card when collapsed, so it never reflows. */}
      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-[7px] bg-accent/10 border border-accent/30 flex items-center justify-center shrink-0">
          <MessageCircleQuestionMark className="w-4 h-4 text-accent" />
        </div>
        <div className="text-sm font-semibold text-foreground truncate min-w-0 flex-1">
          {message}
        </div>
        {isMultiField && (
          <div className="flex gap-1.5 shrink-0">
            {fields.map((field, i) => (
              <Tooltip key={field.key}>
                <TooltipTrigger
                  onClick={() => goTo(i)}
                  className={cn(
                    "w-2 h-2 rounded-full transition-all duration-200 border-none p-0 cursor-pointer",
                    i === currentIndex
                      ? "bg-accent scale-125 shadow-[0_0_0_3px_hsl(var(--accent)/0.25)]"
                      : isAnswered(field)
                        ? "bg-accent/50"
                        : "bg-muted-foreground/30",
                  )}
                />
                <TooltipContent>{field.title ?? field.key}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand the questions" : "Collapse the questions"}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
        >
          <ChevronDown
            className={cn("size-3.5 transition-transform duration-200", !collapsed && "rotate-180")}
          />
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Question body — capped so a long option list scrolls instead of eating the panel. */}
          <div className="max-h-[40vh] overflow-x-hidden overflow-y-auto">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={currentIndex}
                initial={{ x: direction * 16, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: direction * -16, opacity: 0 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
              >
                {currentField && (
                  <div className="space-y-1.5">
                    {currentField.title && (
                      <div className="text-xs font-medium text-foreground">
                        {currentField.title}
                      </div>
                    )}
                    {currentField.description && (
                      <div className="text-xs text-muted-foreground">
                        {currentField.description}
                      </div>
                    )}

                    {/* Single-select (radio) */}
                    {isSingleSelect(currentField) && (
                      <div className={optionList}>
                        {singleSelectOptions.map((opt) => (
                          <OptionRow
                            key={opt.const}
                            type="radio"
                            name={currentField.key}
                            selected={
                              !otherChecked[currentField.key] &&
                              values[currentField.key] === opt.const
                            }
                            onSelect={() => {
                              // Picking a listed option clears Other, and vice versa — one radio
                              // group, so exactly one of them is the answer.
                              setOtherChecked((prev) => ({ ...prev, [currentField.key]: false }));
                              set(currentField.key, opt.const);
                              advanceAfterPick();
                            }}
                          >
                            {opt.title}
                          </OptionRow>
                        ))}
                        {showOtherInput && (
                          <OtherOption
                            label={otherField!.title ?? "Other"}
                            description={otherDescription}
                            type="radio"
                            name={currentField.key}
                            checked={!!otherChecked[currentField.key]}
                            setChecked={(checked) => {
                              setOtherChecked((prev) => ({
                                ...prev,
                                [currentField.key]: checked,
                              }));
                              if (checked) set(currentField.key, undefined);
                            }}
                            value={otherValues[currentField.key] ?? ""}
                            onChange={(v) =>
                              setOtherValues((prev) => ({ ...prev, [currentField.key]: v }))
                            }
                          />
                        )}
                      </div>
                    )}

                    {/* Multi-select (checkbox) */}
                    {isMultiSelect(currentField) && (
                      <div className={optionList}>
                        {multiSelectOptions.map((opt) => {
                          const selected = ((values[currentField.key] as string[]) ?? []).includes(
                            opt.const,
                          );
                          return (
                            <OptionRow
                              key={opt.const}
                              type="checkbox"
                              selected={selected}
                              onSelect={() => {
                                const cur = (values[currentField.key] as string[]) ?? [];
                                set(
                                  currentField.key,
                                  selected
                                    ? cur.filter((x) => x !== opt.const)
                                    : [...cur, opt.const],
                                );
                              }}
                            >
                              {opt.title}
                            </OptionRow>
                          );
                        })}
                        {showOtherInput && (
                          <OtherOption
                            label={otherField!.title ?? "Other"}
                            description={otherDescription}
                            type="checkbox"
                            checked={!!otherChecked[currentField.key]}
                            // Adds to the boxes already ticked rather than replacing them.
                            setChecked={(checked) =>
                              setOtherChecked((prev) => ({ ...prev, [currentField.key]: checked }))
                            }
                            value={otherValues[currentField.key] ?? ""}
                            onChange={(v) =>
                              setOtherValues((prev) => ({ ...prev, [currentField.key]: v }))
                            }
                          />
                        )}
                      </div>
                    )}

                    {/* Boolean */}
                    {currentField.type === "boolean" && (
                      <OptionRow
                        type="checkbox"
                        selected={Boolean(values[currentField.key])}
                        onSelect={() => set(currentField.key, !values[currentField.key])}
                      >
                        {currentField.title ?? currentField.key}
                      </OptionRow>
                    )}

                    {/* Free text */}
                    {!isSingleSelect(currentField) &&
                      !isMultiSelect(currentField) &&
                      currentField.type !== "boolean" && (
                        <Textarea
                          value={(values[currentField.key] as string) ?? ""}
                          onChange={(e) => set(currentField.key, e.target.value)}
                          className="min-h-15 bg-muted/40 border-border focus-visible:border-accent/50 focus-visible:ring-0 text-sm"
                          placeholder="Type here…"
                        />
                      )}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Footer: moving between questions on the left, answering the request on the right —
          declining beside submitting, since both end it. */}
          <div className="flex flex-wrap items-center gap-2">
            {isMultiField && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => goTo(currentIndex - 1)}
                  disabled={currentIndex === 0}
                >
                  <ChevronLeft className="size-3.5" />
                  Prev
                </Button>
                {currentIndex < fields.length - 1 && (
                  <Button variant="outline" size="sm" onClick={() => goTo(currentIndex + 1)}>
                    Next
                    <ChevronRight className="size-3.5" />
                  </Button>
                )}
                {/* Beside the arrows rather than up in the header: it says where they will take you. */}
                <span className="text-xs text-muted-foreground tabular-nums">
                  {currentIndex + 1} / {fields.length}
                </span>
              </>
            )}
            <div className="flex-1" />
            {submitAttempted && unansweredCount > 0 && (
              <span className="text-xs text-muted-foreground">
                {unansweredCount} unanswered, click again
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={() => onDecline(requestId)}>
              Decline
            </Button>
            <Button
              variant={submitAttempted && unansweredCount > 0 ? "outline" : "accent"}
              size="sm"
              onClick={handleSubmit}
              className={
                submitAttempted && unansweredCount > 0
                  ? "border-yellow-500/50 text-yellow-500 hover:bg-yellow-500/10"
                  : ""
              }
            >
              {submitAttempted && unansweredCount > 0 ? "Submit anyway" : "Submit"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
