import { useState } from "react";
import { MessageCircleQuestionMark, ChevronLeft, ChevronRight, Check, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/ui-utils";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";

export interface ElicitationField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "array";
  title?: string;
  description?: string;
  enumValues?: string[];
  oneOf?: { const: string; title: string }[];
  items?: { enum?: string[]; anyOf?: { const: string; title: string }[] };
}

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

function OtherInput({
  field,
  value,
  onChange,
}: {
  field: { key: string; title?: string; description?: string };
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5 mt-2 pt-2 border-t border-border">
      {field.title && <div className="text-xs font-medium text-foreground">{field.title}</div>}
      {field.description && (
        <div className="text-xs text-muted-foreground">{field.description}</div>
      )}
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[60px] bg-muted/40 border-border focus-visible:border-accent/50 focus-visible:ring-0 text-sm"
        placeholder="Type here…"
      />
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
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [direction, setDirection] = useState(1);

  const isMultiField = fields.length > 1;
  const currentField = fields[currentIndex] ?? null;

  const set = (key: string, value: unknown) => setValues((prev) => ({ ...prev, [key]: value }));

  const isAnswered = (field: ElicitationField): boolean => {
    if (otherValues[field.key]) return true;
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
      const ov = otherValues[field.key];
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
      ? (currentField.oneOf ??
        currentField.enumValues?.map((v) => ({ const: v, title: v })) ??
        [])
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

  return (
    <div className="bg-card border-t border-border">
      {/* Header */}
      <div className="flex items-center justify-between px-3.5 pt-3 pb-2 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <MessageCircleQuestionMark className="w-3.5 h-3.5 text-accent flex-shrink-0" />
          <span className="text-sm font-medium text-foreground truncate">{message}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isMultiField && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {currentIndex + 1} / {fields.length}
            </span>
          )}
          <button
            onClick={() => onDecline(requestId)}
            className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Decline"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Progress dots */}
      {isMultiField && (
        <div className="flex gap-1.5 px-3.5 pb-2">
          {fields.map((field, i) => (
            <button
              key={field.key}
              onClick={() => goTo(i)}
              className={cn(
                "w-2 h-2 rounded-full transition-all duration-200 border-none p-0 cursor-pointer",
                i === currentIndex
                  ? "bg-accent scale-125 shadow-[0_0_0_3px_hsl(var(--accent)/0.25)]"
                  : isAnswered(field)
                    ? "bg-accent/50"
                    : "bg-muted-foreground/30",
              )}
              title={field.title ?? field.key}
            />
          ))}
        </div>
      )}

      {/* Question body */}
      <div className="px-3.5 pb-2 overflow-hidden">
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
                  <div className="text-xs font-medium text-foreground">{currentField.title}</div>
                )}
                {currentField.description && (
                  <div className="text-xs text-muted-foreground">{currentField.description}</div>
                )}

                {/* Single-select (radio) */}
                {isSingleSelect(currentField) && (
                  <div className="space-y-1">
                    {singleSelectOptions.map((opt) => {
                      const selected = values[currentField.key] === opt.const;
                      return (
                        <label
                          key={opt.const}
                          className={cn(
                            "flex items-center gap-2 px-2.5 py-1.5 rounded-md border cursor-pointer transition-all text-sm",
                            selected
                              ? "border-accent bg-accent/10 text-foreground"
                              : "border-border text-muted-foreground hover:border-accent/50",
                          )}
                        >
                          <input
                            type="radio"
                            name={currentField.key}
                            className="sr-only"
                            checked={selected}
                            onChange={() => set(currentField.key, opt.const)}
                          />
                          <div
                            className={cn(
                              "w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all",
                              selected ? "border-accent bg-accent" : "border-muted-foreground/40",
                            )}
                          >
                            {selected && (
                              <div className="w-1.5 h-1.5 rounded-full bg-primary-foreground" />
                            )}
                          </div>
                          {opt.title}
                        </label>
                      );
                    })}
                    {showOtherInput && (
                      <OtherInput
                        field={otherField!}
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
                  <div className="space-y-1">
                    {multiSelectOptions.map((opt) => {
                      const selected = (
                        (values[currentField.key] as string[]) ?? []
                      ).includes(opt.const);
                      return (
                        <label
                          key={opt.const}
                          className={cn(
                            "flex items-center gap-2 px-2.5 py-1.5 rounded-md border cursor-pointer transition-all text-sm",
                            selected
                              ? "border-accent bg-accent/10 text-foreground"
                              : "border-border text-muted-foreground hover:border-accent/50",
                          )}
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={selected}
                            onChange={() => {
                              const cur = (values[currentField.key] as string[]) ?? [];
                              set(
                                currentField.key,
                                selected
                                  ? cur.filter((x) => x !== opt.const)
                                  : [...cur, opt.const],
                              );
                            }}
                          />
                          <div
                            className={cn(
                              "w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all",
                              selected ? "border-accent bg-accent" : "border-muted-foreground/40",
                            )}
                          >
                            {selected && (
                              <Check className="w-2.5 h-2.5 text-primary-foreground" />
                            )}
                          </div>
                          {opt.title}
                        </label>
                      );
                    })}
                    {showOtherInput && (
                      <OtherInput
                        field={otherField!}
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
                  <label
                    className={cn(
                      "flex items-center gap-2 px-2.5 py-1.5 rounded-md border cursor-pointer transition-all text-sm",
                      values[currentField.key]
                        ? "border-accent bg-accent/10 text-foreground"
                        : "border-border text-muted-foreground hover:border-accent/50",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={Boolean(values[currentField.key])}
                      onChange={(e) => set(currentField.key, e.target.checked)}
                    />
                    <div
                      className={cn(
                        "w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all",
                        values[currentField.key]
                          ? "border-accent bg-accent"
                          : "border-muted-foreground/40",
                      )}
                    >
                      {Boolean(values[currentField.key]) && (
                        <Check className="w-2.5 h-2.5 text-primary-foreground" />
                      )}
                    </div>
                    {currentField.title ?? currentField.key}
                  </label>
                )}

                {/* Free text */}
                {!isSingleSelect(currentField) &&
                  !isMultiSelect(currentField) &&
                  currentField.type !== "boolean" && (
                    <Textarea
                      value={(values[currentField.key] as string) ?? ""}
                      onChange={(e) => set(currentField.key, e.target.value)}
                      className="min-h-[60px] bg-muted/40 border-border focus-visible:border-accent/50 focus-visible:ring-0 text-sm"
                      placeholder="Type here…"
                    />
                  )}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-3.5 pb-3 gap-2">
        {isMultiField ? (
          <div className="flex gap-1.5">
            <button
              onClick={() => goTo(currentIndex - 1)}
              disabled={currentIndex === 0}
              className="flex items-center gap-1 px-2.5 py-1 rounded border border-muted-foreground text-xs text-foreground hover:border-foreground disabled:opacity-30 disabled:cursor-default transition-colors"
            >
              <ChevronLeft className="w-3 h-3" />
              Prev
            </button>
            {currentIndex < fields.length - 1 && (
              <button
                onClick={() => goTo(currentIndex + 1)}
                className="flex items-center gap-1 px-2.5 py-1 rounded border border-muted-foreground text-xs text-foreground hover:border-foreground transition-colors"
              >
                Next
                <ChevronRight className="w-3 h-3" />
              </button>
            )}
          </div>
        ) : (
          <div />
        )}
        <div className="flex items-center gap-2">
          {submitAttempted && unansweredCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {unansweredCount} unanswered — click again
            </span>
          )}
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
      </div>
    </div>
  );
}

export function parseElicitationFields(payload: Record<string, unknown>): {
  fields: ElicitationField[];
  otherField: { key: string; title?: string; description?: string } | null;
} {
  const schema = payload.requestedSchema as Record<string, unknown> | undefined;
  const properties = (schema?.properties as Record<string, Record<string, unknown>>) ?? {};
  const fields: ElicitationField[] = [];
  let otherField: { key: string; title?: string; description?: string } | null = null;

  for (const [key, prop] of Object.entries(properties)) {
    const type = (prop.type as ElicitationField["type"]) ?? "string";
    const title = prop.title as string | undefined;
    const description = prop.description as string | undefined;
    const hasOptions = !!(prop.oneOf || prop.enum || prop.items);
    const isOtherField =
      (key.toLowerCase() === "other" || title?.toLowerCase() === "other") &&
      type === "string" &&
      !hasOptions;
    if (isOtherField) {
      otherField = { key, title, description };
    } else {
      fields.push({
        key,
        type,
        title,
        description,
        enumValues: prop.enum as string[] | undefined,
        oneOf: prop.oneOf as { const: string; title: string }[] | undefined,
        items: prop.items as ElicitationField["items"],
      });
    }
  }

  return { fields, otherField };
}
