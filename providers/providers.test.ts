import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import type { AddressInfo } from "net";
import { readMessage } from "./anthropic";
import { ollama } from "./ollama";
import { openai, openaiName } from "./openai";
import { abortableRun, ProviderError, ProviderRequest } from "./provider";

const request: ProviderRequest = {
  system: "sys",
  prompt: "note",
  schema: { type: "object" },
  readableDir: null,
  timeoutMs: 5000,
};

/** A local server that records the last request and answers with `respond`. */
async function fakeServer(respond: (body: any) => { status?: number; json: unknown }) {
  const seen: { url?: string; headers?: http.IncomingHttpHeaders; body?: any } = {};
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      Object.assign(seen, { url: req.url, headers: req.headers, body: JSON.parse(text) });
      const { status = 200, json } = respond(seen.body);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => server.close() };
}

test("openai: sends a strict json_schema chat request and reads the reply", async () => {
  const server = await fakeServer(() => ({
    json: { choices: [{ finish_reason: "stop", message: { content: '{"edits":[],"skipped":[],"summary":"ok"}' } }] },
  }));
  try {
    const provider = openai({ baseUrl: server.url + "/v1/", apiKey: "k", model: "m" });
    assert.deepEqual(await provider.run(request).reply, { edits: [], skipped: [], summary: "ok" });
    assert.equal(server.seen.url, "/v1/chat/completions");
    assert.equal(server.seen.headers?.authorization, "Bearer k");
    assert.equal(server.seen.body.model, "m");
    assert.deepEqual(server.seen.body.messages.map((m: any) => m.role), ["system", "user"]);
    assert.equal(server.seen.body.response_format.json_schema.strict, true);
  } finally {
    server.close();
  }
});

test("openai: surfaces API errors and refusals", async () => {
  const errors = await fakeServer(() => ({ status: 401, json: { error: { message: "Incorrect API key" } } }));
  try {
    await assert.rejects(openai({ baseUrl: errors.url, apiKey: "bad", model: "m" }).run(request).reply, /Incorrect API key/);
  } finally {
    errors.close();
  }
  const refusal = await fakeServer(() => ({ json: { choices: [{ message: { refusal: "no" } }] } }));
  try {
    await assert.rejects(openai({ baseUrl: refusal.url, apiKey: "k", model: "m" }).run(request).reply, /declined: no/);
  } finally {
    refusal.close();
  }
});

test("openai: names the provider after its host", () => {
  assert.equal(openaiName(""), "ChatGPT");
  assert.equal(openaiName("https://api.x.ai/v1"), "Grok");
  assert.equal(openaiName("http://localhost:1234/v1"), "localhost:1234");
});

test("ollama: sends the schema as format and reads the reply", async () => {
  const server = await fakeServer(() => ({ json: { done_reason: "stop", message: { content: '{"edits":[]}' } } }));
  try {
    assert.deepEqual(await ollama({ url: server.url, model: "llama3.2" }).run(request).reply, { edits: [] });
    assert.equal(server.seen.url, "/api/chat");
    assert.deepEqual(server.seen.body.format, request.schema);
    assert.equal(server.seen.body.stream, false);
  } finally {
    server.close();
  }
});

test("ollama: explains an unreachable server, a missing model, and missing settings", async () => {
  await assert.rejects(ollama({ url: "http://127.0.0.1:1", model: "x" }).run(request).reply, /Couldn't connect/);
  const server = await fakeServer(() => ({ status: 404, json: { error: "model 'x' not found" } }));
  try {
    await assert.rejects(ollama({ url: server.url, model: "x" }).run(request).reply, /model 'x' not found/);
  } finally {
    server.close();
  }
  await assert.rejects(ollama({ url: "", model: "" }).run(request).reply, /Set an Ollama model/);
});

test("anthropic: reads JSON text and explains refusals and cut-offs", () => {
  assert.deepEqual(readMessage({ stop_reason: "end_turn", content: [{ type: "text", text: '{"edits":[]}' }] }), { edits: [] });
  assert.throws(() => readMessage({ stop_reason: "refusal", content: [] }), /declined/);
  assert.throws(() => readMessage({ stop_reason: "max_tokens", content: [] }), /cut off/);
  assert.throws(() => readMessage({ stop_reason: "end_turn", content: [{ type: "text", text: "nope" }] }), ProviderError);
});

test("abortableRun reports cancel and timeout distinctly", async () => {
  const hang = (signal: AbortSignal) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const cancelled = abortableRun(5000, hang);
  cancelled.cancel();
  await assert.rejects(cancelled.reply, new ProviderError("Cancelled."));
  await assert.rejects(abortableRun(20, hang).reply, new ProviderError("Timed out after 0.02s."));
});
