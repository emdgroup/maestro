import { describe, expect, it } from "vitest";
import { cardMove } from "./useCardMotion";

const at = (column: string, y = 0) => ({ column, x: 0, y });

describe("cardMove", () => {
  it("settles in a card the board has never drawn", () => {
    expect(cardMove(undefined, false, at("Planning"))).toBe("enter");
  });

  it("leaves alone a card a filter had hidden", () => {
    expect(cardMove(undefined, true, at("Planning"))).toBeNull();
  });

  it("flies a card that changed column, even to the same height", () => {
    expect(cardMove(at("Queue", 8), true, at("Review", 8))).toBe("fly");
  });

  it("slides a card its column reflowed, and only then", () => {
    expect(cardMove(at("Queue", 8), true, at("Queue", 90))).toBe("reflow");
    expect(cardMove(at("Queue", 8), true, at("Queue", 8))).toBeNull();
  });
});
