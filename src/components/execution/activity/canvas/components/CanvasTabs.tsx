import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/ui/tabs";
import type { CanvasComponent, CanvasSurface } from "../../types";
import { CanvasComponentNode } from "../CanvasRenderer";

interface TabItem {
  label: string;
  childId: string;
}

interface Props {
  tabs?: TabItem[];
  surface: CanvasSurface;
  component: CanvasComponent;
  depth: number;
  [key: string]: unknown;
}

export function CanvasTabs({ tabs = [], surface, depth }: Props) {
  if (tabs.length === 0) return null;
  return (
    <Tabs defaultValue={tabs[0]?.childId}>
      <TabsList>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.childId} value={tab.childId}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.childId} value={tab.childId} className="pt-3">
          <CanvasComponentNode surface={surface} componentId={tab.childId} depth={depth + 1} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
