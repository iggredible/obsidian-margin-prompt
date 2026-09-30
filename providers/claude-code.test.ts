import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOutput } from "./claude-code";
import { ProviderError } from "./provider";

test("returns structured_output", () => {
  const stdout = JSON.stringify({ is_error: false, result: "{}", structured_output: { edits: [], summary: "x" } });
  assert.deepEqual(parseOutput(stdout), { edits: [], summary: "x" });
});

test("surfaces Claude Code's own error message", () => {
  const stdout = JSON.stringify({ is_error: true, subtype: "success", result: "Not logged in · Please run /login" });
  assert.throws(() => parseOutput(stdout), new ProviderError("Not logged in · Please run /login"));
});

test("rejects output that isn't a structured result", () => {
  assert.throws(() => parseOutput(""), ProviderError);
  assert.throws(() => parseOutput(JSON.stringify({ is_error: false, result: "hi" })), ProviderError);
});
