import { describe, expect, it } from "vitest";
import { drainSseBuffer, parseSseFrame } from "./api";

describe("parseSseFrame", () => {
  it("strips exactly one space after the field colon", () => {
    expect(parseSseFrame("event: text\ndata: hello")).toEqual({ event: "text", data: "hello" });
    // Two spaces means the second one is content.
    expect(parseSseFrame("event: text\ndata:  hello")).toEqual({ event: "text", data: " hello" });
  });

  it("joins multiple data lines with a newline", () => {
    // This is the regression that mattered: the old parser did
    // `data += line.slice(5).trim()`, so a streamed paragraph arrived as one
    // run-on line with every leading and trailing space gone.
    expect(parseSseFrame("event: text\ndata: line one\ndata: line two")).toEqual({
      event: "text",
      data: "line one\nline two",
    });
  });

  it("preserves leading and trailing whitespace inside a delta", () => {
    expect(parseSseFrame("event: text\ndata:  the lighthouse keeper ")).toEqual({
      event: "text",
      data: " the lighthouse keeper ",
    });
  });

  it("preserves a deliberately empty data line as a blank line", () => {
    expect(parseSseFrame("event: text\ndata: para one\ndata:\ndata: para two")).toEqual({
      event: "text",
      data: "para one\n\npara two",
    });
  });

  it("handles an event with empty data, as `done` sends", () => {
    expect(parseSseFrame("event: done\ndata:")).toEqual({ event: "done", data: "" });
  });

  it("ignores comment/heartbeat lines", () => {
    expect(parseSseFrame(":keep-alive")).toBeNull();
    expect(parseSseFrame(":keep-alive\nevent: text\ndata: x")).toEqual({
      event: "text",
      data: "x",
    });
  });

  it("defaults the event name to message", () => {
    expect(parseSseFrame("data: bare")).toEqual({ event: "message", data: "bare" });
  });
});

describe("drainSseBuffer", () => {
  it("returns complete frames and keeps the partial remainder", () => {
    const { frames, rest } = drainSseBuffer("event: text\ndata: a\n\nevent: text\ndata: b");
    expect(frames).toEqual([{ event: "text", data: "a" }]);
    expect(rest).toBe("event: text\ndata: b");
  });

  it("drains several frames arriving in one chunk", () => {
    const { frames, rest } = drainSseBuffer(
      "event: text\ndata: a\n\nevent: tool_call\ndata: {}\n\nevent: done\ndata:\n\n",
    );
    expect(frames.map((f) => f.event)).toEqual(["text", "tool_call", "done"]);
    expect(rest).toBe("");
  });

  it("reassembles a frame split mid-event across network chunks", () => {
    // Simulates reader.read() handing back arbitrary byte boundaries.
    const whole = "event: text\ndata: the lighthouse\ndata: keeper\n\n";
    let buffer = "";
    const collected = [];
    for (const chunk of [whole.slice(0, 7), whole.slice(7, 20), whole.slice(20)]) {
      buffer += chunk;
      const { frames, rest } = drainSseBuffer(buffer);
      buffer = rest;
      collected.push(...frames);
    }
    expect(collected).toEqual([{ event: "text", data: "the lighthouse\nkeeper" }]);
  });

  it("normalises CRLF so a proxy rewriting line endings can't hide frames", () => {
    const { frames } = drainSseBuffer("event: text\r\ndata: a\r\n\r\n");
    expect(frames).toEqual([{ event: "text", data: "a" }]);
  });

  it("leaves an unterminated trailing frame in the remainder for the final flush", () => {
    const { frames, rest } = drainSseBuffer("event: done\ndata:");
    expect(frames).toEqual([]);
    expect(parseSseFrame(rest)).toEqual({ event: "done", data: "" });
  });
});
