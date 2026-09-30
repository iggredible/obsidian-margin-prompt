// The task we give the model, whichever provider runs it: the system prompt,
// the note plus instructions, and the shape of the reply.
import type { Edit, PromptComment } from "./comments";
import { ProviderError } from "./providers/provider";

/** Something for the model to do: a prompt comment, or a prompt the user typed with the cursor at `line`:`column`. */
export type Instruction = Pick<PromptComment, "prompt" | "line"> & { typed?: boolean; column?: number };

export interface Reply {
  edits: Edit[];
  skipped: number[]; // 1-based numbers of instructions the model didn't carry out
  summary: string;
}

export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: { old_text: { type: "string" }, new_text: { type: "string" } },
        required: ["old_text", "new_text"],
        additionalProperties: false,
      },
    },
    skipped: { type: "array", items: { type: "integer" } },
    summary: { type: "string" },
  },
  required: ["edits", "skipped", "summary"],
  additionalProperties: false,
};

export const SYSTEM_PROMPT = `You carry out instructions that a user has left as comments inside their Obsidian note. The comments look like %% instruction %% or <!-- instruction -->. You are given the note and a numbered list of the comments to act on. Reply with edits to the note.

How to edit:
- Each edit replaces old_text with new_text. Copy old_text exactly from the note, including whitespace and line breaks, and make it long enough to appear only once in the note. Edits must not overlap.
- Change only what the instructions ask for. Keep everything else exactly as it is, including Markdown and Obsidian syntax such as [[links]], ![[embeds]], #tags, callouts and frontmatter.
- Words like "below", "above", "here" and "this paragraph" are relative to the comment. "The block below" means the paragraph, list, table or code block right after the comment.
- Don't edit or remove the instruction comments themselves. If an edit's old_text includes one, copy it unchanged into new_text. The plugin deals with the comments afterward.
- Ignore comments that aren't in the list.
- An instruction marked "typed" came from a prompt box rather than a comment, and comes with the cursor's position. For it, "here" means the cursor; otherwise decide from the instruction where the change belongs. To insert at the cursor, use an empty old_text: new_text then goes in exactly at the cursor, so include any line breaks it needs.
- If an instruction is unclear or impossible, skip it: put its number in skipped and say why in the summary.

summary: one short sentence on what you changed, shown to the user in a notification.`;

export function buildPrompt(
  notePath: string,
  doc: string,
  instructions: Instruction[],
  vaultPath: string | null,
  now = new Date(),
): string {
  // The model has no clock, so give it one for prompts like "insert today's date".
  const lines = [`Note: ${notePath}`, `Current time: ${now.toISOString()} (UTC); local: ${now.toString()}`];
  if (vaultPath) {
    lines.push(`Vault root: ${vaultPath} (you may read other notes there to carry out the instructions)`);
  }
  lines.push("", "Instructions to carry out:");
  instructions.forEach((c, i) => {
    const where = c.typed ? `typed, cursor at line ${c.line}, column ${c.column ?? 1}` : `line ${c.line}`;
    lines.push(`${i + 1}. (${where}) ${c.prompt}`);
  });
  // The <note> wrapper hides whether the note ends with a newline, which old_text must match.
  const ending = doc.endsWith("\n") ? "ends with a newline" : "does not end with a newline";
  lines.push("", `The note's full text (it ${ending}):`, "<note>", doc, "</note>");
  return lines.join("\n");
}

/** Check a provider's structured output against the reply shape. */
export function readReply(data: unknown): Reply {
  const d = data as Partial<Reply> | null;
  if (!d || !Array.isArray(d.edits)) throw new ProviderError("The model didn't return any edits.");
  return {
    edits: d.edits,
    skipped: Array.isArray(d.skipped) ? d.skipped : [],
    summary: typeof d.summary === "string" ? d.summary : "",
  };
}
