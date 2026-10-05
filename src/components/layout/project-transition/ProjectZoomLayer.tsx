import { useLayoutEffect } from "react";
import { useAnimate } from "framer-motion";
import { useTheme } from "@/providers/ThemeProvider";
import { useZoomStore } from "./projectTransition";
import type { Box } from "./projectTransition";

const EASE = [0.2, 0.8, 0.2, 1] as const;
const GROW = 0.38;

/** A box a third of the window, centred: where a project with no tile on Home grows from. */
function middle(): Box {
  const width = window.innerWidth / 3;
  const height = window.innerHeight / 3;
  return { left: width, top: height, width, height };
}

const whole = (): Box => ({
  left: 0,
  top: 0,
  width: window.innerWidth,
  height: window.innerHeight,
});

function place(element: HTMLElement, box: Box, radius: number, opacity: number) {
  Object.assign(element.style, {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    borderRadius: `${radius}px`,
    opacity: String(opacity),
  });
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/**
 * The card that grows out of a Home tile into the project, and shrinks back into it. It stands in
 * for the project while the window switches underneath it: the open grows it over Home, switches,
 * then fades it off the project; the close covers the project, switches, then shrinks into Home.
 */
export function ProjectZoomLayer() {
  const zoom = useZoomStore((state) => state.zoom);
  const { reduceMotion } = useTheme();
  const [scope, animate] = useAnimate<HTMLDivElement>();

  // A layout effect so the card is in place before the frame that shows the switch is painted.
  useLayoutEffect(() => {
    const element = scope.current;
    if (!zoom || !element) return;
    const run = async () => {
      if (zoom.kind === "open") {
        if (reduceMotion) {
          place(element, whole(), 0, 1);
        } else {
          place(element, zoom.from ?? middle(), 16, 1);
          await animate(
            element,
            { ...px(whole()), borderRadius: 0 },
            { duration: GROW, ease: EASE },
          );
        }
        zoom.grown();
        await nextFrame();
        await animate(element, { opacity: 0 }, { duration: 0.22 });
      } else {
        place(element, whole(), 0, 1);
        // Home draws its tiles on the frame after the switch.
        await nextFrame();
        await nextFrame();
        if (!reduceMotion) {
          const to = zoom.to() ?? middle();
          await animate(element, { ...px(to), borderRadius: 16 }, { duration: GROW, ease: EASE });
        }
        await animate(element, { opacity: 0 }, { duration: 0.18 });
      }
      useZoomStore.setState({ zoom: null });
    };
    void run();
  }, [zoom, reduceMotion, animate, scope]);

  return (
    <div
      ref={scope}
      aria-hidden
      style={{ opacity: 0, width: 0, height: 0 }}
      className="pointer-events-none fixed z-[100] overflow-hidden border border-foreground/10 bg-background shadow-2xl"
    >
      <span className="header-gradient" style={{ bottom: "auto", height: 52 }} />
    </div>
  );
}

function px(box: Box) {
  return {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  };
}
