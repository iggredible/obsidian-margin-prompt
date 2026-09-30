// Pure text logic: finding prompt comments in a note and turning Claude's edits
// into non-overlapping changes. No Obsidian imports, so it is easy to unit-test.

/** A comment in the note that we treat as an instruction. Offsets index into the note. */
export interface PromptComment {
  start: number;
  end: number;
  raw: string; // e.g. "%% Capitalize the block below %%"
  prompt: string; // e.g. "Capitalize the block below"
  line: number; // 1-based
}

/** One edit as Claude returns it: replace `old_text` (unique in the note) with `new_text`. */
export interface Edit {
  old_text: string;
  new_text: string;
}

/** A replacement of the range [from, to) of the original text. */
export interface Change {
  from: number;
  to: number;
  text: string;
}

/** Thrown when Claude's edits can't be applied cleanly; nothing should be changed. */
export class PlanError extends Error {}

const DELIMITERS = [
  { open: "%%", close: "%%" },
  { open: "<!--", close: "-->" },
];

/**
 * Ranges where comment syntax is literal text rather than a comment:
 * frontmatter, fenced code blocks, and inline code spans.
 */
function literalRanges(doc: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  const fm = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(doc);
  if (fm) ranges.push([0, fm[0].length]);

  let fence: { char: string; len: number; start: number } | null = null;
  let offset = 0;
  for (const line of doc.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!fence && m) {
      fence = { char: m[1][0], len: m[1].length, start: offset };
    } else if (
      fence &&
      m &&
      m[1][0] === fence.char &&
      m[1].length >= fence.len &&
      line.slice(m[0].length).trim() === ""
    ) {
      ranges.push([fence.start, offset + line.length]);
      fence = null;
    }
    offset += line.length + 1;
  }
  if (fence) ranges.push([fence.start, doc.length]); // an unclosed fence runs to the end

  const inline = /(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g;
  for (let m; (m = inline.exec(doc)); ) ranges.push([m.index, m.index + m[0].length]);

  return ranges;
}

/**
 * Find `%% … %%` and `<!-- … -->` comments, skipping empty ones and any inside
 * code or frontmatter. With a `prefix` (e.g. "claude:"), only comments starting
 * with it count, and the prefix is stripped from the prompt.
 */
export function findComments(doc: string, prefix = ""): PromptComment[] {
  const literal = literalRanges(doc);
  const found: PromptComment[] = [];
  let i = 0;

  while (i < doc.length) {
    let next: { at: number; open: string; close: string } | null = null;
    for (const d of DELIMITERS) {
      const at = doc.indexOf(d.open, i);
      if (at !== -1 && (!next || at < next.at)) next = { at, ...d };
    }
    if (!next) break;

    const skip = literal.find(([s, e]) => s <= next!.at && next!.at < e);
    if (skip) {
      i = skip[1];
      continue;
    }

    const closeAt = doc.indexOf(next.close, next.at + next.open.length);
    if (closeAt === -1) break; // unclosed: not something we can safely act on
    const end = closeAt + next.close.length;
    i = end;

    let prompt = doc.slice(next.at + next.open.length, closeAt).trim();
    if (prefix) {
      if (!prompt.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      prompt = prompt.slice(prefix.length).trim();
    }
    if (!prompt) continue;

    found.push({
      start: next.at,
      end,
      raw: doc.slice(next.at, end),
      prompt,
      line: doc.slice(0, next.at).split("\n").length,
    });
  }

  return found;
}

/**
 * The range to delete to remove the comment at [start, end) from `text`.
 * A comment alone on its line takes the whole line with it; one at the end or
 * start of a line takes the whitespace between it and the text; one mid-line
 * takes one neighbouring space so "a %% x %% b" becomes "a b".
 */
export function removalRange(text: string, start: number, end: number): { from: number; to: number } {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = text.indexOf("\n", end);
  if (lineEnd === -1) lineEnd = text.length;
  const before = text.slice(lineStart, start);
  const after = text.slice(end, lineEnd);

  if (before.trim() === "" && after.trim() === "") {
    if (lineEnd < text.length) return { from: lineStart, to: lineEnd + 1 };
    return { from: Math.max(0, lineStart - 1), to: lineEnd }; // last line: drop the newline before it
  }
  if (after.trim() === "") return { from: lineStart + before.trimEnd().length, to: lineEnd };
  if (before.trim() === "") return { from: start, to: lineEnd - after.trimStart().length };
  if (text[start - 1] === " " && text[end] === " ") return { from: start, to: end + 1 };
  return { from: start, to: end };
}

function stripComment(text: string, raw: string): string {
  const at = text.indexOf(raw);
  if (at === -1) return text;
  const r = removalRange(text, at, at + raw.length);
  return text.slice(0, r.from) + text.slice(r.to);
}

function preview(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? flat.slice(0, 57) + "…" : flat;
}

/**
 * Turn Claude's edits into changes against `doc`, located by text rather than
 * offset so they still land correctly if the note changed while Claude worked.
 * `processed` are the raw comments Claude carried out; with `removeComments`
 * they are deleted too. An edit with an empty `old_text` inserts at `cursor`
 * (an offset), for typed prompts. Throws PlanError if any edit can't be placed.
 */
export function planChanges(
  doc: string,
  edits: Edit[],
  processed: string[],
  removeComments: boolean,
  cursor?: number,
): Change[] {
  const changes: Change[] = [];
  for (const e of edits) {
    if (e.old_text === e.new_text) continue;
    if (!e.old_text) {
      if (cursor === undefined) throw new PlanError("Claude returned an edit with no text to replace.");
      const at = Math.min(cursor, doc.length); // the note may have shrunk while Claude worked
      changes.push({ from: at, to: at, text: e.new_text });
      continue;
    }
    const at = doc.indexOf(e.old_text);
    if (at === -1) throw new PlanError(`Couldn't find "${preview(e.old_text)}" in the note.`);
    if (doc.indexOf(e.old_text, at + 1) !== -1) {
      throw new PlanError(`"${preview(e.old_text)}" appears more than once in the note.`);
    }
    changes.push({ from: at, to: at + e.old_text.length, text: e.new_text });
  }
  changes.sort((a, b) => a.from - b.from || a.to - b.to); // an insertion goes before a replacement at the same spot
  for (let k = 1; k < changes.length; k++) {
    if (changes[k].from < changes[k - 1].to) throw new PlanError("Claude returned overlapping edits.");
  }

  // Without a real edit, keep the comments so the instructions aren't lost.
  if (!removeComments || changes.length === 0) return changes;

  const taken = [...changes];
  const overlaps = (from: number, to: number) => taken.some((c) => c.from < to && from < c.to);
  const pending = [...processed];
  for (const c of findComments(doc)) {
    const k = pending.indexOf(c.raw);
    if (k === -1) continue;
    pending.splice(k, 1);

    const host = changes.find((ch) => ch.from <= c.start && c.end <= ch.to);
    if (host) {
      host.text = stripComment(host.text, c.raw);
      continue;
    }
    if (overlaps(c.start, c.end)) continue; // Claude rewrote part of it; leave the rest alone

    const r = removalRange(doc, c.start, c.end);
    taken.push(overlaps(r.from, r.to) ? { from: c.start, to: c.end, text: "" } : { ...r, text: "" });
  }

  return taken.sort((a, b) => a.from - b.from);
}

/** Apply non-overlapping changes (in original-text offsets) to `doc`. */
export function applyChanges(doc: string, changes: Change[]): string {
  return [...changes]
    .sort((a, b) => b.from - a.from || b.to - a.to) // back to front; at a shared spot, replace before inserting
    .reduce((text, c) => text.slice(0, c.from) + c.text + text.slice(c.to), doc);
}
