import { useState } from "react";
import { MessageSquare } from "lucide-react";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";

interface ElicitationField {
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
  onSubmit: (requestId: string, values: Record<string, unknown>) => void;
  onDecline: (requestId: string) => void;
}

export function ElicitationPrompt({ requestId, message, fields, onSubmit, onDecline }: ElicitationPromptProps) {
  const [values, setValues] = useState<Record<string, unknown>>({});

  const set = (key: string, value: unknown) => setValues((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = () => {
    onSubmit(requestId, values);
  };

  return (
    <div className="border-t border-border bg-background px-3.5 py-3">
      <div className="flex items-center gap-2 mb-2.5">
        <MessageSquare className="w-4 h-4 text-accent flex-shrink-0" />
        <span className="text-sm font-medium text-foreground">{message}</span>
      </div>

      <div className="space-y-2 mb-3">
        {fields.map((field) => {
          const label = field.title ?? field.key;
          if (field.type === "boolean") {
            return (
              <label key={field.key} className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(values[field.key])}
                  onChange={(e) => set(field.key, e.target.checked)}
                  className="accent-accent"
                />
                {label}
              </label>
            );
          }
          if ((field.type === "string" && field.oneOf) || (field.type === "string" && field.enumValues)) {
            const options = field.oneOf ?? field.enumValues?.map((v) => ({ const: v, title: v })) ?? [];
            return (
              <div key={field.key} className="space-y-1">
                {label && <div className="text-xs text-muted-foreground">{label}</div>}
                {options.map((opt) => (
                  <label key={opt.const} className={`flex items-center gap-2 text-sm px-2.5 py-1.5 rounded-md border cursor-pointer transition-colors ${values[field.key] === opt.const ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted-foreground hover:border-accent/50"}`}>
                    <input type="radio" name={field.key} value={opt.const} checked={values[field.key] === opt.const} onChange={() => set(field.key, opt.const)} className="sr-only" />
                    {opt.title}
                  </label>
                ))}
              </div>
            );
          }
          if (field.type === "array") {
            const options = field.items?.anyOf ?? field.items?.enum?.map((v) => ({ const: v, title: v })) ?? [];
            const selected = (values[field.key] as string[]) ?? [];
            const toggle = (v: string) => set(field.key, selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
            return (
              <div key={field.key} className="space-y-1">
                {label && <div className="text-xs text-muted-foreground">{label}</div>}
                {options.map((opt) => (
                  <label key={opt.const} className={`flex items-center gap-2 text-sm px-2.5 py-1.5 rounded-md border cursor-pointer transition-colors ${selected.includes(opt.const) ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted-foreground hover:border-accent/50"}`}>
                    <input type="checkbox" checked={selected.includes(opt.const)} onChange={() => toggle(opt.const)} className="sr-only" />
                    {opt.title}
                  </label>
                ))}
              </div>
            );
          }
          return (
            <div key={field.key}>
              {label && <div className="text-xs text-muted-foreground mb-1">{label}</div>}
              <Textarea
                value={(values[field.key] as string) ?? ""}
                onChange={(e) => set(field.key, e.target.value)}
                className="min-h-9 bg-muted/40 border-border focus-visible:border-accent/50 focus-visible:ring-0 text-sm"
              />
            </div>
          );
        })}
      </div>

      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => onDecline(requestId)}>
          Decline
        </Button>
        <Button variant="accent" size="sm" onClick={handleSubmit}>
          Submit
        </Button>
      </div>
    </div>
  );
}

export function parseElicitationFields(payload: Record<string, unknown>): { message: string; fields: ElicitationField[] } {
  const message = (payload.message as string) ?? "Please provide information";
  const schema = payload.requestedSchema as Record<string, unknown> | undefined;
  const properties = (schema?.properties as Record<string, Record<string, unknown>>) ?? {};
  const fields: ElicitationField[] = Object.entries(properties).map(([key, prop]) => ({
    key,
    type: (prop.type as ElicitationField["type"]) ?? "string",
    title: prop.title as string | undefined,
    description: prop.description as string | undefined,
    enumValues: prop.enum as string[] | undefined,
    oneOf: prop.oneOf as { const: string; title: string }[] | undefined,
    items: prop.items as ElicitationField["items"],
  }));
  return { message, fields };
}
