/**
 * A deliberately tiny inline-markdown renderer for assistant messages.
 *
 * Why not `react-markdown`: the agent's output is prose and short
 * explanations, so bold/italic/code/links/lists/blockquotes cover it, and
 * pulling in a full CommonMark pipeline for that would also pull in an HTML
 * passthrough path. Here the input is escaped first and only a fixed set of
 * patterns is ever re-introduced, so there is no route from model output to
 * live markup.
 */

export interface MdBlock {
  kind: "paragraph" | "bullet" | "ordered" | "quote" | "code";
  /** Pre-escaped HTML containing only the inline marks this module emits. */
  html: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A sentinel for extracted code spans. It survives escaping untouched and
 * cannot be produced by escapeHtml, so model output containing the literal
 * text cannot forge one: the `@` and digits are left alone by escaping, but
 * the index must also match a span we actually extracted.
 */
const CODE_OPEN = "@@inkcode";
const CODE_CLOSE = "@@";

/** Inline marks, applied to already-escaped text. */
export function renderInline(text: string): string {
  let out = escapeHtml(text);

  // Code spans come out first so emphasis markers inside them stay literal,
  // and go back in last.
  const codeSpans: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(code);
    return `${CODE_OPEN}${codeSpans.length - 1}${CODE_CLOSE}`;
  });

  // [label](url), restricted to http(s) so a javascript: or data: URL can
  // never become a live link.
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, href: string) =>
      `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );

  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");

  const spanPattern = new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, "g");
  out = out.replace(spanPattern, (match, index: string) => {
    const code = codeSpans[Number(index)];
    return code === undefined ? match : `<code>${code}</code>`;
  });

  return out;
}

/**
 * Splits a message into blocks. This runs on whatever has streamed in so far,
 * so it has to tolerate a half-written line — including an unterminated code
 * fence, which renders as code rather than disappearing until its closing
 * backticks arrive.
 */
export function parseMarkdown(source: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = source.split("\n");

  let paragraph: string[] = [];
  let fence: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", html: renderInline(paragraph.join(" ")) });
      paragraph = [];
    }
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (fence === null) {
        flushParagraph();
        fence = [];
      } else {
        blocks.push({ kind: "code", html: escapeHtml(fence.join("\n")) });
        fence = null;
      }
      continue;
    }

    if (fence !== null) {
      fence.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      blocks.push({ kind: "bullet", html: renderInline(bullet[1]) });
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      blocks.push({ kind: "ordered", html: renderInline(ordered[1]) });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      blocks.push({ kind: "quote", html: renderInline(quote[1]) });
      continue;
    }

    // Headings don't get their own block: in a narrow side panel an <h2>
    // reads as noise, so the marker is dropped and the text emphasised.
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "paragraph", html: `<strong>${renderInline(heading[1])}</strong>` });
      continue;
    }

    paragraph.push(line);
  }

  if (fence !== null) blocks.push({ kind: "code", html: escapeHtml(fence.join("\n")) });
  flushParagraph();

  return blocks;
}
