// OpenAI's Chat Completions API, and servers compatible with it (xAI's Grok,
// OpenRouter, LM Studio, …) via a different base URL.
import { postJson } from "./http";
import { abortableRun, failedRun, parseJsonReply, Provider, ProviderError, ProviderRequest } from "./provider";

export interface OpenAIOptions {
  baseUrl: string; // e.g. https://api.openai.com/v1 or https://api.x.ai/v1
  apiKey: string;
  model: string;
}

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** A friendly name for notices, from the server's host. */
export function openaiName(baseUrl: string): string {
  const host = new URL(baseUrl || OPENAI_BASE_URL).host;
  if (host.endsWith("openai.com")) return "ChatGPT";
  if (host.endsWith("x.ai")) return "Grok";
  return host;
}

export function chatRequestBody(request: ProviderRequest, model: string): object {
  return {
    model,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.prompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "note_edits", strict: true, schema: request.schema },
    },
  };
}

/** Pull the structured reply out of a chat completion. */
export function readCompletion(res: any, name: string): unknown {
  const choice = res?.choices?.[0];
  if (!choice) throw new ProviderError(`${name} returned no reply.`);
  if (choice.message?.refusal) throw new ProviderError(`${name} declined: ${choice.message.refusal}`);
  if (choice.finish_reason === "length") throw new ProviderError(`${name}'s reply was cut off. The note may be too long.`);
  return parseJsonReply(choice.message?.content, name);
}

export function openai(opts: OpenAIOptions): Provider {
  const baseUrl = (opts.baseUrl.trim() || OPENAI_BASE_URL).replace(/\/+$/, "");
  const name = openaiName(baseUrl);
  return {
    name,
    run(request) {
      if (!opts.model.trim()) return failedRun("Set a model in the Margin Prompt settings.");
      const headers: Record<string, string> = opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {};
      return abortableRun(request.timeoutMs, (signal) =>
        postJson(`${baseUrl}/chat/completions`, chatRequestBody(request, opts.model.trim()), headers, signal).then(
          (res) => readCompletion(res, name),
        ),
      );
    },
  };
}
