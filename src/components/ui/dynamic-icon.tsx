import type { ElementType } from "react";

/**
 * Renders an icon component chosen at runtime.
 *
 * Assigning a capitalized local from a function call and then rendering it reads to the
 * React Compiler as a component being built during render, which opts the surrounding
 * component out of optimisation entirely. Passing the type in as a prop keeps that
 * selection out of the render body, so classifiers like `rowIcon` and `docIcon` can stay
 * as they are.
 */
export function DynamicIcon({ icon: Icon, className }: { icon: ElementType; className?: string }) {
  return <Icon className={className} />;
}
