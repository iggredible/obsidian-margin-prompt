import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChanges, Edit, findComments, planChanges, PlanError } from "./comments";

/** Plan and apply in one go, the way the plugin does for a closed file. */
function run(doc: string, edits: Edit[], removeComments = true, done?: string[]): string {
  const processed = done ?? findComments(doc).map((c) => c.raw);
  return applyChanges(doc, planChanges(doc, edits, processed, removeComments));
}

test("finds both comment styles, inline and multi-line", () => {
  const doc = "# T\n\n%% Capitalize the block below %%\ntext <!-- fix\ntypos --> more\n";
  const found = findComments(doc);
  assert.deepEqual(
    found.map((c) => [c.prompt, c.line, c.raw]),
    [
      ["Capitalize the block below", 3, "%% Capitalize the block below %%"],
      ["fix\ntypos", 4, "<!-- fix\ntypos -->"],
    ],
  );
  assert.equal(doc.slice(found[1].start, found[1].end), found[1].raw);
});

test("ignores comment syntax in code, frontmatter, and empty or unclosed comments", () => {
  const doc = [
    "---",
    "note: 50%% done %%",
    "---",
    "Use `%% like this %%` for comments.",
    "```md",
    "%% in a fence %%",
    "```",
    "%%  %%",
    "%% real one %%",
    "%% never closed",
  ].join("\n");
  assert.deepEqual(findComments(doc).map((c) => c.prompt), ["real one"]);
});

test("a prefix picks out prompt comments and is stripped", () => {
  const doc = "%% just a note %%\n%% Claude: shorten this %%\n<!-- claude:fix typos -->";
  assert.deepEqual(findComments(doc, "claude:").map((c) => c.prompt), ["shorten this", "fix typos"]);
});

test("applies an edit and removes the comment's whole line", () => {
  const doc = "# T\n\n%% Capitalize the block below %%\nthe quick fox\n\nAfter.\n";
  const out = run(doc, [{ old_text: "the quick fox", new_text: "THE QUICK FOX" }]);
  assert.equal(out, "# T\n\nTHE QUICK FOX\n\nAfter.\n");
});

test("strips a comment Claude kept inside its edit", () => {
  const doc = "%% Capitalize below %%\nthe quick fox\n";
  const out = run(doc, [
    { old_text: "%% Capitalize below %%\nthe quick fox", new_text: "%% Capitalize below %%\nTHE QUICK FOX" },
  ]);
  assert.equal(out, "THE QUICK FOX\n");
});

test("an insertion after a comment takes the comment's place", () => {
  const doc = "Intro\n%% list three fruits here %%\nOutro";
  const out = run(doc, [
    { old_text: "%% list three fruits here %%", new_text: "%% list three fruits here %%\n- apple\n- pear\n- fig" },
  ]);
  assert.equal(out, "Intro\n- apple\n- pear\n- fig\nOutro");
});

test("removes inline comments without leaving stray spaces", () => {
  const doc = "a %% make this bold %% **b** c\nteh end <!-- fix typo -->\n  %% indent kept %% text";
  const edits = [
    { old_text: "c\n", new_text: "C\n" },
    { old_text: "teh", new_text: "the" },
    { old_text: "text", new_text: "TEXT" },
  ];
  assert.equal(run(doc, edits), "a **b** C\nthe end\n  TEXT");
});

test("removes comments on the last lines when there's no trailing newline", () => {
  const doc = "text\n%% a %%\n%% b %%";
  assert.equal(run(doc, [{ old_text: "text", new_text: "TEXT" }]), "TEXT\n");
});

test("keeps comments when asked to", () => {
  const doc = "%% Capitalize below %%\nfox\n";
  assert.equal(run(doc, [{ old_text: "fox", new_text: "FOX" }], false), "%% Capitalize below %%\nFOX\n");
});

test("keeps comments Claude skipped, and all comments when nothing was edited", () => {
  const doc = "%% do A %%\na\n%% do B %%\nb\n";
  assert.equal(run(doc, [{ old_text: "a", new_text: "A" }], true, ["%% do A %%"]), "A\n%% do B %%\nb\n");
  assert.equal(run(doc, []), doc);
});

test("locates edits by text, so they survive changes made while Claude worked", () => {
  const before = "%% fix %%\nteh cat\n";
  const edits = [{ old_text: "teh cat", new_text: "the cat" }];
  const processed = findComments(before).map((c) => c.raw);
  const now = "New line typed meanwhile.\n" + before;
  assert.equal(applyChanges(now, planChanges(now, edits, processed, true)), "New line typed meanwhile.\nthe cat\n");
});

test("refuses edits that are missing, ambiguous, or overlapping", () => {
  const doc = "%% x %%\none two one\n";
  const plan = (edits: Edit[]) => planChanges(doc, edits, ["%% x %%"], true);
  assert.throws(() => plan([{ old_text: "three", new_text: "3" }]), PlanError);
  assert.throws(() => plan([{ old_text: "one", new_text: "1" }]), PlanError);
  assert.throws(
    () => plan([{ old_text: "one two", new_text: "1 2" }, { old_text: "two one", new_text: "2 1" }]),
    PlanError,
  );
});

test("an empty old_text inserts at the cursor", () => {
  const doc = "---\ncreated_at: 2026-09-30\n---";
  const edits = [{ old_text: "", new_text: "\nRain on the roof." }];
  assert.equal(applyChanges(doc, planChanges(doc, edits, [], true, doc.length)), doc + "\nRain on the roof.");
  assert.equal(applyChanges(doc, planChanges(doc, edits, [], true, 999)), doc + "\nRain on the roof.");
  assert.throws(() => planChanges(doc, edits, [], true), PlanError); // no cursor: comment runs
});

test("an insertion and a replacement can share a spot", () => {
  const doc = "abc";
  const edits = [{ old_text: "abc", new_text: "ABC" }, { old_text: "", new_text: ">" }];
  assert.equal(applyChanges(doc, planChanges(doc, edits, [], true, 0)), ">ABC");
});
