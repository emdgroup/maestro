export interface ElicitationField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "array";
  title?: string;
  description?: string;
  enumValues?: string[];
  oneOf?: { const: string; title: string }[];
  items?: { enum?: string[]; anyOf?: { const: string; title: string }[] };
}

export function parseElicitationFields(payload: Record<string, unknown>): {
  fields: ElicitationField[];
  otherField: { key: string; title?: string; description?: string } | null;
} {
  const message = payload.message as string;
  const schema = payload.requestedSchema as Record<string, unknown> | undefined;
  const properties = (schema?.properties as Record<string, Record<string, unknown>>) ?? {};
  const fields: ElicitationField[] = [];
  let otherField: { key: string; title?: string; description?: string } | null = null;

  for (const [key, prop] of Object.entries(properties)) {
    const type = (prop.type as ElicitationField["type"]) ?? "string";
    const title = prop.title as string | undefined;
    const description = (prop.description as string | undefined) ?? message;
    const hasOptions = !!(prop.oneOf || prop.enum || prop.items);
    const isOtherField =
      (key === "customAnswer" || title === "Other") && type === "string" && !hasOptions;
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
