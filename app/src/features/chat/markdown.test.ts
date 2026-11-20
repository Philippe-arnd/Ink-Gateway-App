import { describe, expect, it } from "vitest";
import { parseMarkdown, renderInline } from "./markdown";

describe("renderInline escaping", () => {
  it("escapes markup so model output cannot inject elements", () => {
    expect(renderInline("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes attribute-breaking characters", () => {
    expect(renderInline(`a " b ' c & d`)).toBe("a &quot; b &#39; c &amp; d");
  });

  it("only linkifies http(s) targets", () => {
    expect(renderInline("[x](https://example.com)")).toContain('href="https://example.com"');
    // A javascript: or data: URL must stay inert text.
    expect(renderInline("[x](javascript:alert(1))")).not.toContain("<a");
    expect(renderInline("[x](data:text/html,<b>)")).not.toContain("<a");
  });

  it("marks external links noopener", () => {
    expect(renderInline("[x](https://example.com)")).toContain('rel="noopener noreferrer"');
  });

  it("renders bold and italic", () => {
    expect(renderInline("**bold**")).toBe("<strong>bold</strong>");
    expect(renderInline("say *softly*")).toBe("say <em>softly</em>");
  });

  it("keeps emphasis markers literal inside code spans", () => {
    expect(renderInline("`a **b** c`")).toBe("<code>a **b** c</code>");
  });

  it("does not let literal sentinel text in model output forge a code span", () => {
    // The sentinel only resolves for indices actually extracted this pass.
    const out = renderInline("@@inkcode0@@");
    expect(out).toBe("@@inkcode0@@");
    expect(out).not.toContain("<code>");
  });

  it("escapes inside a code span too", () => {
    expect(renderInline("`<b>`")).toBe("<code>&lt;b&gt;</code>");
  });
});

describe("parseMarkdown blocks", () => {
  it("splits paragraphs on blank lines", () => {
    const blocks = parseMarkdown("one\n\ntwo");
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "paragraph"]);
    expect(blocks[1].html).toBe("two");
  });

  it("recognises bullets, ordered items and quotes", () => {
    const blocks = parseMarkdown("- a\n1. b\n> c");
    expect(blocks.map((b) => b.kind)).toEqual(["bullet", "ordered", "quote"]);
  });

  it("flattens headings to emphasis rather than shrinking the panel's hierarchy", () => {
    const blocks = parseMarkdown("## Chapitre");
    expect(blocks).toEqual([{ kind: "paragraph", html: "<strong>Chapitre</strong>" }]);
  });

  it("renders a fenced code block", () => {
    const blocks = parseMarkdown("```\nlet x = 1;\n```");
    expect(blocks).toEqual([{ kind: "code", html: "let x = 1;" }]);
  });

  it("renders an unterminated fence as code while it is still streaming", () => {
    // Mid-stream the closing backticks have not arrived yet; the text must
    // not vanish until they do.
    const blocks = parseMarkdown("```\nhalf written");
    expect(blocks).toEqual([{ kind: "code", html: "half written" }]);
  });

  it("escapes inside a fenced block", () => {
    expect(parseMarkdown("```\n<b>\n```")[0].html).toBe("&lt;b&gt;");
  });

  it("returns nothing for empty input, so an unstarted message renders blank", () => {
    expect(parseMarkdown("")).toEqual([]);
  });
});
