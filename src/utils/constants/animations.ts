/**
 * Animation variants for page transitions and UI effects
 */

/**
 * Slide animation variants for page transitions
 * Used with framer-motion AnimatePresence for smooth page navigation
 */
export const slideVariants = {
  enter: (direction: number) => ({
    x: `${100 * direction}%`,
    opacity: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
  },
  exit: (direction: number) => ({
    x: `${-100 * direction}%`,
    opacity: 0,
  }),
};

/**
 * Standard transition duration for page slides (in seconds)
 */
export const PAGE_TRANSITION_DURATION = 0.25;

/**
 * Standard easing function for page transitions
 */
export const PAGE_TRANSITION_EASING = "easeInOut";
