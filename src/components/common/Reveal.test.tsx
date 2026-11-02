import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AnimatePresence } from "framer-motion";
import { RevealRow } from "./Reveal";

const list = (rows: string[]) => (
  <AnimatePresence initial={false}>
    {rows.map((row) => (
      <RevealRow key={row}>
        <div>{row}</div>
      </RevealRow>
    ))}
  </AnimatePresence>
);

describe("RevealRow", () => {
  it("draws a list's first rows at once, opens a new one and closes a removed one", async () => {
    const { rerender } = render(list(["a", "b"]));
    expect(screen.getByText("a").parentElement!.style.height).not.toBe("0px");

    rerender(list(["c", "a", "b"]));
    expect(screen.getByText("c")).toBeTruthy();
    expect(screen.getByText("c").parentElement!.style.height).toBe("0px");

    rerender(list(["c", "b"]));
    expect(screen.getByText("a")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("a")).toBeNull());
    expect(screen.getByText("b")).toBeTruthy();
  });
});
