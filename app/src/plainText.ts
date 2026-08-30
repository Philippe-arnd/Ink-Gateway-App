import { Node, Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

/**
 * A single-block, no-marks TipTap schema: `doc(block(text*))`. This is what
 * makes character-offset math with the API trivial and exact — ProseMirror
 * position `p` inside the one block always equals `charOffset + 1` (1 for
 * entering the block node), with zero separators to account for between
 * paragraphs. Enter inserts a literal "\n" instead of splitting into a new
 * block (splitting isn't even possible — the doc only permits exactly one
 * block).
 *
 * This also happens to satisfy "prose-only, no formatting toolbar" from the
 * spec: `marks: ""` means bold/italic/etc. can't exist in this schema at all.
 */
export const PlainDoc = Node.create({
  name: "doc",
  topNode: true,
  content: "block",
});

export const PlainBlock = Node.create({
  name: "block",
  content: "text*",
  marks: "",
  code: true,
  whitespace: "pre",
  parseHTML() {
    return [{ tag: "div" }];
  },
  renderHTML() {
    return ["div", { class: "plain-block" }, 0];
  },
});

export const PlainTextKeymap = Extension.create({
  name: "plainTextKeymap",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown: (view, event) => {
            if (event.key === "Enter") {
              view.dispatch(view.state.tr.insertText("\n"));
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});

export function charOffsetToPos(offset: number): number {
  return offset + 1;
}

export function posToCharOffset(pos: number): number {
  return Math.max(0, pos - 1);
}
