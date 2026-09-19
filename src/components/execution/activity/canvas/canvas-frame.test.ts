import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BRIDGE, wantsViewportHeight } from "./canvas-frame";

/**
 * The bridge runs inside the canvas frame, so it is exercised here the way the frame runs it:
 * evaluated against a real document, with `parent.postMessage` watched.
 *
 * In this environment `parent === window`, which is what makes that watchable — the bridge reads
 * `host.postMessage` at call time, so spying on the window before it runs is enough.
 */
function runBridge(body: string) {
  document.body.innerHTML = body;
  const posted: Array<Record<string, unknown>> = [];
  const spy = vi
    .spyOn(window, "postMessage")
    .mockImplementation((message: unknown) => void posted.push(message as Record<string, unknown>));
  new Function(BRIDGE)();
  return { posted, spy };
}

/** The `canvas-record` payloads, as the host would fold them into `values`. */
function values(posted: Array<Record<string, unknown>>) {
  const bag: Record<string, unknown> = {};
  for (const message of posted) {
    if (message.type === "canvas-record") bag[message.id as string] = message.value;
  }
  return bag;
}

beforeEach(() => {
  // The bridge observes the document on startup; happy-dom has no ResizeObserver of its own.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("wantsViewportHeight", () => {
  it("catches the layouts that cannot be measured from their content", () => {
    expect(wantsViewportHeight(".app { height: 100vh; overflow: hidden }")).toBe(true);
    expect(wantsViewportHeight("<body><div class='h-screen flex'></div></body>")).toBe(true);
    expect(wantsViewportHeight("<div class='min-h-screen'></div>")).toBe(true);
    expect(wantsViewportHeight("height:100dvh")).toBe(true);
  });

  it("leaves a flow document to be auto-sized", () => {
    expect(wantsViewportHeight("<div class='rounded-lg border p-4'>hi</div>")).toBe(false);
    // A height that is not the whole viewport still grows with its content.
    expect(wantsViewportHeight(".chart { height: 40vh }")).toBe(false);
  });
});

describe("canvas bridge auto-wiring", () => {
  it("answers an untouched form with its defaults, not with nothing", () => {
    const { posted } = runBridge(`
      <form id="ship">
        <input id="branchName" value="maestro/grim-leaf-149" />
        <select id="strategy">
          <option value="squash" selected>Squash</option>
          <option value="merge">Merge</option>
        </select>
        <input type="checkbox" id="deleteBranch" checked />
        <button type="button" id="approve">Approve</button>
      </form>
    `);

    document.getElementById("approve")!.click();

    // Nothing was typed, changed or clicked before this — a form whose defaults are already
    // right is the normal case for a confirmation, and it has to answer with them.
    expect(values(posted)).toEqual({
      branchName: "maestro/grim-leaf-149",
      strategy: "squash",
      deleteBranch: true,
    });
    expect(posted).toContainEqual(
      expect.objectContaining({ type: "canvas-event", id: "approve", kind: "click" }),
    );
  });

  it("scopes a button in a form to that form, leaving another form's fields out", () => {
    const { posted } = runBridge(`
      <form id="left"><input id="a" value="1" /><button type="button" id="goLeft">Go</button></form>
      <form id="right"><input id="b" value="2" /><button type="button" id="goRight">Go</button></form>
    `);

    document.getElementById("goLeft")!.click();

    expect(values(posted)).toEqual({ a: "1" });
  });

  it("takes the whole document for a button that belongs to no form", () => {
    const { posted } = runBridge(`
      <input id="threshold" type="number" value="8" />
      <button type="button" id="apply">Apply</button>
    `);

    document.getElementById("apply")!.click();

    expect(values(posted)).toEqual({ threshold: 8 });
  });

  it("still answers a submit with every field", () => {
    const { posted } = runBridge(`
      <form id="ship"><input id="branchName" value="main" /><button id="go">Go</button></form>
    `);

    document.getElementById("ship")!.dispatchEvent(new Event("submit", { bubbles: true }));

    expect(values(posted)).toEqual({ branchName: "main" });
    expect(posted).toContainEqual(
      expect.objectContaining({ type: "canvas-event", id: "ship", kind: "submit" }),
    );
  });
});
