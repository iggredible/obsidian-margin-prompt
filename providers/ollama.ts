// A local model served by Ollama (https://ollama.com), through its /api/chat endpoint.
import { postJson } from "./http";
import { abortableRun, failedRun, parseJsonReply, Provider, ProviderError, ProviderRequest } from "./provider";

export interface OllamaOptions {
  url: string; // e.g. http://localhost:11434
  model: string; // e.g. llama3.2
}

export const OLLAMA_URL = "http://localhost:11434";

export function ollamaRequestBody(request: ProviderRequest, model: string): object {
  return {
    model,
    stream: false,
    format: request.schema, // Ollama constrains the output to this JSON Schema
    think: false, // thinking models can reason for minutes; these edits don't need it (ignored by other models)
    options: { temperature: 0 }, // edits must copy old_text exactly, so no creativity there
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.prompt },
    ],
  };
}

export function readChat(res: any): unknown {
  if (res?.done_reason === "length") throw new ProviderError("Ollama's reply was cut off. The note may be too long.");
  return parseJsonReply(res?.message?.content, "Ollama");
}

export function ollama(opts: OllamaOptions): Provider {
  const url = (opts.url.trim() || OLLAMA_URL).replace(/\/+$/, "");
  return {
    name: "Ollama",
    run(request) {
      if (!opts.model.trim()) return failedRun("Set an Ollama model in the Margin Prompt settings (see `ollama list`).");
      return abortableRun(request.timeoutMs, (signal) =>
        postJson(`${url}/api/chat`, ollamaRequestBody(request, opts.model.trim()), {}, signal).then(readChat),
      );
    },
  };
}
