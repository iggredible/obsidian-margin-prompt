import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, readReply } from "./prompt";
import { ProviderError } from "./providers/provider";

test("marks typed prompts with the cursor line, and comments with theirs", () => {
  const prompt = buildPrompt("a.md", "doc", [
    { prompt: "fix typos", line: 3 },
    { prompt: "add a title", line: 1, column: 5, typed: true },
  ], null);
  assert.match(prompt, /^1\. \(line 3\) fix typos$/m);
  assert.match(prompt, /^2\. \(typed, cursor at line 1, column 5\) add a title$/m);
});

test("says whether the note ends with a newline", () => {
  assert.match(buildPrompt("a.md", "---\nx: 1\n---", [], null), /does not end with a newline/);
  assert.match(buildPrompt("a.md", "text\n", [], null), /\(it ends with a newline\)/);
});

test("reads a reply, filling in optional fields", () => {
  assert.deepEqual(readReply({ edits: [{ old_text: "a", new_text: "A" }], skipped: [2], summary: "Done." }), {
    edits: [{ old_text: "a", new_text: "A" }],
    skipped: [2],
    summary: "Done.",
  });
  assert.deepEqual(readReply({ edits: [] }), { edits: [], skipped: [], summary: "" });
});

test("rejects a reply without edits", () => {
  assert.throws(() => readReply(null), ProviderError);
  assert.throws(() => readReply({ summary: "hi" }), ProviderError);
});
