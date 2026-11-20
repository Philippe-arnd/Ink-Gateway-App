import { describe, expect, it } from "vitest";
import { charOffsetToPos, posToCharOffset } from "./plainText";

/**
 * The editor's schema is deliberately `doc(block(text*))` with no marks, so a
 * ProseMirror position inside the single block is always `charOffset + 1` —
 * the 1 being the step into the block node, with no inter-paragraph
 * separators to account for.
 *
 * Every character offset in the system rides on this: the API's
 * insert_text/rewrite_range primitives, comment anchors, selection ranges
 * sent to the agent, and the diff. If the schema ever gains a second block
 * or a mark, these tests are what fail first.
 */
describe("plain-text offset invariant", () => {
  it("maps offset 0 to position 1", () => {
    expect(charOffsetToPos(0)).toBe(1);
  });

  it("round-trips every offset in a realistic range", () => {
    for (let offset = 0; offset < 5000; offset++) {
      expect(posToCharOffset(charOffsetToPos(offset))).toBe(offset);
    }
  });

  it("round-trips positions back to offsets", () => {
    for (let pos = 1; pos < 5000; pos++) {
      expect(charOffsetToPos(posToCharOffset(pos))).toBe(pos);
    }
  });

  it("clamps position 0 rather than returning a negative offset", () => {
    // Position 0 is before the block node and has no character offset; a
    // negative offset would be sent to the API as a usize and rejected.
    expect(posToCharOffset(0)).toBe(0);
    expect(posToCharOffset(-5)).toBe(0);
  });

  it("keeps a selection's width intact across the mapping", () => {
    const selections: Array<[number, number]> = [
      [0, 0],
      [0, 12],
      [40, 41],
      [1200, 3400],
    ];
    for (const [from, to] of selections) {
      expect(posToCharOffset(charOffsetToPos(to)) - posToCharOffset(charOffsetToPos(from))).toBe(
        to - from,
      );
    }
  });
});
