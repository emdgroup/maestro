import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "framer-motion";

/**
 * One row of a list that opens as it arrives and closes as it leaves. Give it a key, inside an
 * `<AnimatePresence initial={false}>` around the list, so the list's first draw stays still. The
 * height goes back to `auto` afterwards, so output still arriving keeps growing the row.
 */
export function RevealRow({ children }: { children: ReactNode }) {
  // MotionConfig's reduced mode only stops transforms and layout, and height is neither.
  const reduced = useReducedMotionConfig();
  return (
    <motion.div
      initial={{ height: 0, opacity: 0, overflow: "hidden" }}
      animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
      exit={{ height: 0, opacity: 0, overflow: "hidden" }}
      transition={{ duration: reduced ? 0 : 0.22, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Opens and closes its content by height, so what sits below moves instead of jumping. `initial` is
 * off so content already open when the stream draws, as a lone tool call is, does not animate.
 */
export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>{open && <RevealRow>{children}</RevealRow>}</AnimatePresence>
  );
}
