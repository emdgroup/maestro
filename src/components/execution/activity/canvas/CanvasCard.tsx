import { useState } from "react";
import { LayoutDashboard, ChevronDown, ChevronUp, Code } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/ui/button";
import { ScrollArea } from "@/ui/scroll-area";
import type { CanvasItem, CanvasSurface } from "../types";
import { CanvasRenderer } from "./CanvasRenderer";

interface Props {
  item: CanvasItem;
  surface: CanvasSurface | undefined;
}

export function CanvasCard({ surface }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [showJson, setShowJson] = useState(false);

  if (!surface) return null;

  const isEmpty = surface.components.length === 0;

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="w-full flex items-center gap-2.5 px-3.5 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2.5 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity"
        >
          <div className="w-6 h-6 rounded-md bg-accent/15 flex items-center justify-center shrink-0">
            <LayoutDashboard className="w-3.5 h-3.5 text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium truncate block">{surface.title}</span>
            {isEmpty && <span className="text-xs text-muted-foreground">Loading…</span>}
            {!isEmpty && (
              <span className="text-xs text-muted-foreground">
                {surface.components.length} component{surface.components.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          {expanded && !isEmpty && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => setShowJson((v) => !v)}
              title={showJson ? "Show preview" : "Show JSON"}
            >
              <Code className="w-3.5 h-3.5" />
            </Button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>
      <AnimatePresence>
        {expanded && !isEmpty && (
          <motion.div
            key="canvas-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="border-t">
              <ScrollArea className="max-h-[600px]">
                <div className="p-4">
                  {showJson ? (
                    <pre className="text-xs font-mono bg-muted rounded p-3 overflow-x-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(
                        { components: surface.components, data: surface.data },
                        null,
                        2,
                      )}
                    </pre>
                  ) : (
                    <CanvasRenderer surface={surface} />
                  )}
                </div>
              </ScrollArea>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
