import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { SegmentThumb } from "./SegmentThumb";

describe("SegmentThumb", () => {
  it("follows the pressed option, and hides with none pressed", async () => {
    const { container } = render(
      <div>
        <SegmentThumb />
        <button aria-pressed="true">A</button>
        <button aria-pressed="false">B</button>
      </div>,
    );
    const thumb = container.querySelector("span")!;
    const [a, b] = container.querySelectorAll("button");
    vi.spyOn(b, "getBoundingClientRect").mockReturnValue({ left: 40, top: 0 } as DOMRect);
    expect(thumb.style.opacity).toBe("1");

    a.setAttribute("aria-pressed", "false");
    b.setAttribute("aria-pressed", "true");
    await waitFor(() => expect(thumb.style.transform).toBe("translate(40px, 0px)"));

    b.setAttribute("aria-pressed", "false");
    await waitFor(() => expect(thumb.style.opacity).toBe("0"));
  });
});
