/**
 * Collapses a full-text edit into the single character range that actually
 * changed, by walking in from both ends. The API's edit primitives are
 * offset-based (`rewrite_range(start, end, content)`), so this is what turns
 * "the editor's new text" into one minimal, git-committable call.
 *
 * Worst case — an edit touching both ends, e.g. select-all-and-paste — this
 * correctly degrades to rewriting the whole document.
 */
export function diffRange(
  oldText: string,
  newText: string,
): { start: number; end: number; content: string } {
  let start = 0;
  const maxStart = Math.min(oldText.length, newText.length);
  while (start < maxStart && oldText[start] === newText[start]) start++;

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  return { start, end: oldEnd, content: newText.slice(start, newEnd) };
}

/** Applies what `diffRange` describes — the server's side of the contract. */
export function applyRange(
  oldText: string,
  { start, end, content }: { start: number; end: number; content: string },
): string {
  return oldText.slice(0, start) + content + oldText.slice(end);
}
