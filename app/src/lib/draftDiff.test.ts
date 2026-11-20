import { describe, expect, it } from "vitest";
import { applyRange, diffRange } from "./draftDiff";

/** The contract: applying what diffRange reports must reproduce newText. */
function roundTrips(a: string, b: string) {
  return applyRange(a, diffRange(a, b)) === b;
}

describe("diffRange", () => {
  it("reports an empty edit for identical text", () => {
    expect(diffRange("hello", "hello")).toEqual({ start: 5, end: 5, content: "" });
  });

  it("isolates a single-word insertion in the middle", () => {
    expect(diffRange("the cat sat", "the black cat sat")).toEqual({
      start: 4,
      end: 4,
      content: "black ",
    });
  });

  it("isolates a deletion", () => {
    const d = diffRange("the black cat sat", "the cat sat");
    expect(d.content).toBe("");
    expect(applyRange("the black cat sat", d)).toBe("the cat sat");
  });

  it("degrades to a whole-document rewrite when both ends change", () => {
    const before = "alpha beta gamma";
    const after = "ALPHA beta GAMMA";
    expect(diffRange(before, after)).toEqual({
      start: 0,
      end: before.length,
      content: after,
    });
  });

  it("handles appending to an empty document", () => {
    expect(diffRange("", "first words")).toEqual({ start: 0, end: 0, content: "first words" });
  });

  it("handles clearing a document", () => {
    expect(diffRange("gone", "")).toEqual({ start: 0, end: 4, content: "" });
  });

  it("preserves newlines, which the plain-text schema stores literally", () => {
    const before = "line one\nline two";
    const after = "line one\nline one and a half\nline two";
    expect(roundTrips(before, after)).toBe(true);
  });

  it("round-trips a repeated-character edit, where prefix/suffix scans can overlap", () => {
    expect(roundTrips("aaaa", "aa")).toBe(true);
    expect(roundTrips("aa", "aaaa")).toBe(true);
    expect(roundTrips("abab", "abb")).toBe(true);
  });

  it("round-trips multi-byte text without splitting a surrogate pair", () => {
    // JS string indices are UTF-16 code units; an emoji is two of them. The
    // prefix/suffix scan must not land between them.
    const before = "chapitre 🌊 un";
    const after = "chapitre 🌊 deux";
    expect(roundTrips(before, after)).toBe(true);
    expect(roundTrips("a🌊b", "a🌊🌊b")).toBe(true);
  });

  it("round-trips an exhaustive set of small string pairs", () => {
    const alphabet = ["", "a", "b", "ab", "ba", "aab", "aba", "abc", "a\nb"];
    for (const a of alphabet) {
      for (const b of alphabet) {
        expect(roundTrips(a, b), `${JSON.stringify(a)} -> ${JSON.stringify(b)}`).toBe(true);
      }
    }
  });
});
