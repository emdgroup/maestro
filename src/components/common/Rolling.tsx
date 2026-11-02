import { AnimatePresence, motion } from "framer-motion";

/**
 * A number that rolls up when it changes, the old value leaving above the new one. Render it in a
 * `relative overflow-hidden` element, which is what clips the two as they pass.
 */
export function Rolling({ value }: { value: string | number }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={value}
        className="inline-block"
        initial={{ y: "100%", opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: "-100%", opacity: 0 }}
        transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
      >
        {value}
      </motion.span>
    </AnimatePresence>
  );
}
