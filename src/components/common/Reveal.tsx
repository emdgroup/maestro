import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "framer-motion";

/**
 * Opens and closes its content by height, so what sits below moves instead of jumping. `initial` is
 * off so content already open when the stream draws, as a lone tool call is, does not animate. The
 * height goes back to `auto` afterwards, so output still arriving keeps growing the row.
 */
export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  // MotionConfig's reduced mode only stops transforms and layout, and height is neither.
  const reduced = useReducedMotionConfig();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0, overflow: "hidden" }}
          animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
          exit={{ height: 0, opacity: 0, overflow: "hidden" }}
          transition={{ duration: reduced ? 0 : 0.22, ease: [0.2, 0.8, 0.2, 1] }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
