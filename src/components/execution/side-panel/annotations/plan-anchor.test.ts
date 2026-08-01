import { describe, it, expect } from "vitest";
import { rangeForQuote } from "./plan-anchor";

function mount(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("rangeForQuote", () => {
  it("finds a quote that spans two elements", () => {
    const el = mount("<p>guarded so it <strong>never overwrites</strong> a value</p>");
    const range = rangeForQuote(el, "it never overwrites a", 0);
    expect(range?.toString()).toBe("it never overwrites a");
  });

  it("picks the requested occurrence when the text repeats", () => {
    const el = mount("<p>reload settings</p><p>then reload settings again</p>");
    const first = rangeForQuote(el, "reload settings", 0);
    const second = rangeForQuote(el, "reload settings", 1);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Second match sits inside the second paragraph.
    expect(second!.startContainer.parentElement?.textContent).toContain("again");
    expect(first!.startContainer.parentElement?.textContent).not.toContain("again");
  });

  it("returns null when the quote is gone or asked for past the last occurrence", () => {
    const el = mount("<p>reload settings</p>");
    expect(rangeForQuote(el, "not in here", 0)).toBeNull();
    expect(rangeForQuote(el, "reload settings", 1)).toBeNull();
    expect(rangeForQuote(el, "", 0)).toBeNull();
  });
});
