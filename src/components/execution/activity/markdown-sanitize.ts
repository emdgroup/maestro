import { defaultSchema } from "rehype-sanitize";
import { isValidElement, type ReactNode, type ReactElement } from "react";

export const sanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: "",
  tagNames: [...(defaultSchema.tagNames ?? []), "mark"],
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), "data"],
  },
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "align"],
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height"],
    a: [...(defaultSchema.attributes?.a ?? []), "dataOpenFileUri"],
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    span: [...(defaultSchema.attributes?.span ?? []), "className", "style"],
    div: [...(defaultSchema.attributes?.div ?? []), "className"],
    h1: [...(defaultSchema.attributes?.h1 ?? []), "id"],
    h2: [...(defaultSchema.attributes?.h2 ?? []), "id"],
    h3: [...(defaultSchema.attributes?.h3 ?? []), "id"],
    h4: [...(defaultSchema.attributes?.h4 ?? []), "id"],
    h5: [...(defaultSchema.attributes?.h5 ?? []), "id"],
    h6: [...(defaultSchema.attributes?.h6 ?? []), "id"],
  },
};

export const SVG_ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "use",
  "symbol",
  "marker",
  "pattern",
  "filter",
  "fegaussianblur",
  "feoffset",
  "femerge",
  "femergenode",
  "animate",
  "animatetransform",
]);

export const SVG_ALLOWED_ATTRS = new Set([
  "viewbox",
  "width",
  "height",
  "xmlns",
  "fill",
  "stroke",
  "stroke-width",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "x1",
  "x2",
  "y",
  "y1",
  "y2",
  "points",
  "transform",
  "opacity",
  "font-size",
  "font-family",
  "text-anchor",
  "style",
  "offset",
  "stop-color",
  "stop-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "id",
  "class",
  "gradientunits",
  "dx",
  "dy",
  "dominant-baseline",
  "fill-opacity",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "attributename",
  "attributetype",
  "from",
  "to",
  "by",
  "values",
  "dur",
  "begin",
  "end",
  "repeatcount",
  "repeatdur",
  "fill",
  "calcmode",
  "keytimes",
  "keysplines",
  "keypoints",
  "additive",
  "accumulate",
  "type",
]);

export function sanitizeSvg(raw: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, "image/svg+xml");
  if (doc.querySelector("parsererror")) return "";

  function walkNode(node: Element) {
    const attrsToRemove: string[] = [];
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || !SVG_ALLOWED_ATTRS.has(name)) {
        attrsToRemove.push(attr.name);
      }
    }
    for (const attr of attrsToRemove) node.removeAttribute(attr);

    const toRemove: Element[] = [];
    for (const child of Array.from(node.children)) {
      if (!SVG_ALLOWED_ELEMENTS.has(child.tagName.toLowerCase())) {
        toRemove.push(child);
      } else {
        walkNode(child);
      }
    }
    for (const el of toRemove) el.remove();
  }

  const svgEl = doc.documentElement;
  if (svgEl.tagName.toLowerCase() !== "svg") return "";
  walkNode(svgEl);
  return new XMLSerializer().serializeToString(svgEl);
}

export function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node))
    return extractText((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}
