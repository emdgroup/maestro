import type { CanvasSurface } from "../types";
import { CanvasColumn } from "./components/CanvasColumn";
import { CanvasRow } from "./components/CanvasRow";
import { CanvasList } from "./components/CanvasList";
import { CanvasCardComponent } from "./components/CanvasCardComponent";
import { CanvasTabs } from "./components/CanvasTabs";
import { CanvasDivider } from "./components/CanvasDivider";
import { CanvasText } from "./components/CanvasText";
import { CanvasImage } from "./components/CanvasImage";
import { CanvasIcon } from "./components/CanvasIcon";
import { CanvasVideo } from "./components/CanvasVideo";
import { CanvasButton } from "./components/CanvasButton";
import { CanvasTextField } from "./components/CanvasTextField";
import { CanvasCheckBox } from "./components/CanvasCheckBox";
import { CanvasChoicePicker } from "./components/CanvasChoicePicker";
import { CanvasSlider } from "./components/CanvasSlider";
import { CanvasDateTimeInput } from "./components/CanvasDateTimeInput";
import { CanvasDataTable } from "./components/CanvasDataTable";
import { CanvasMarkdown } from "./components/CanvasMarkdown";
import { CanvasAudioPlayer } from "./components/CanvasAudioPlayer";
import { CanvasModal } from "./components/CanvasModal";
import { CanvasHtml } from "./components/CanvasHtml";

export function resolveDataBindings(
  props: Record<string, unknown>,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "string" && value.startsWith("/")) {
      resolved[key] = data[value] ?? value;
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

interface RendererProps {
  surface: CanvasSurface;
  componentId: string;
  depth?: number;
}

export function CanvasComponentNode({ surface, componentId, depth = 0 }: RendererProps) {
  const component = surface.components.find((c) => c.id === componentId);
  if (!component) return null;
  if (depth > 20) return null;

  const { id: _id, component: type, children, ...rawProps } = component;
  const props = resolveDataBindings(rawProps as Record<string, unknown>, surface.data);

  const renderChildren = () =>
    children?.map((childId) => (
      <CanvasComponentNode key={childId} surface={surface} componentId={childId} depth={depth + 1} />
    ));

  switch (type) {
    case "Column":
      return <CanvasColumn {...props}>{renderChildren()}</CanvasColumn>;
    case "Row":
      return <CanvasRow {...props}>{renderChildren()}</CanvasRow>;
    case "List":
      return <CanvasList {...props} surface={surface} depth={depth} />;
    case "Card":
      return <CanvasCardComponent {...props}>{renderChildren()}</CanvasCardComponent>;
    case "Tabs":
      return <CanvasTabs {...props} surface={surface} component={component} depth={depth} />;
    case "Divider":
      return <CanvasDivider {...props} />;
    case "Text":
      return <CanvasText {...props} />;
    case "Image":
      return <CanvasImage {...props} />;
    case "Icon":
      return <CanvasIcon {...props} />;
    case "Video":
      return <CanvasVideo {...props} />;
    case "Button":
      return <CanvasButton {...props} />;
    case "TextField":
      return <CanvasTextField {...props} />;
    case "CheckBox":
      return <CanvasCheckBox {...props} />;
    case "ChoicePicker":
      return <CanvasChoicePicker {...props} />;
    case "Slider":
      return <CanvasSlider {...props} />;
    case "DateTimeInput":
      return <CanvasDateTimeInput {...props} />;
    case "DataTable":
      return <CanvasDataTable {...props} surface={surface} />;
    case "Markdown":
      return <CanvasMarkdown {...props} />;
    case "AudioPlayer":
      return <CanvasAudioPlayer {...props} />;
    case "Modal":
      return <CanvasModal {...props}>{renderChildren()}</CanvasModal>;
    case "Html":
      return <CanvasHtml {...props} />;
    default:
      return (
        <div className="text-xs text-muted-foreground border border-dashed rounded p-2">
          Unknown component: {type}
        </div>
      );
  }
}

interface CanvasRendererProps {
  surface: CanvasSurface;
}

export function CanvasRenderer({ surface }: CanvasRendererProps) {
  const referencedIds = new Set(
    surface.components.flatMap((c) => c.children ?? []),
  );
  const roots = surface.components.filter((c) => !referencedIds.has(c.id));

  return (
    <div className="flex flex-col gap-3">
      {roots.map((root) => (
        <CanvasComponentNode key={root.id} surface={surface} componentId={root.id} />
      ))}
    </div>
  );
}
