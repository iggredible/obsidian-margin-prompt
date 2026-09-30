// Claude through the Claude API, with an Anthropic API key.
import Anthropic from "@anthropic-ai/sdk";
import { abortableRun, failedRun, parseJsonReply, Provider, ProviderError } from "./provider";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  effort: string; // empty = the model's default
}

export const ANTHROPIC_MODELS: Record<string, string> = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-4-5": "Claude Haiku 4.5 (fastest)",
  "claude-fable-5-1": "Claude Fable 5.1 (most capable)",
};
export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

// Models that accept server-side refusal fallbacks: if a safety classifier
// declines, the API retries on a suitable model instead of failing.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
// Haiku 4.5 rejects the effort setting.
const NO_EFFORT_MODELS = new Set(["claude-haiku-4-5"]);

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Pull the structured reply out of a Messages API response. */
export function readMessage(message: { stop_reason: string | null; content: Array<{ type: string; text?: string }> }): unknown {
  if (message.stop_reason === "refusal") throw new ProviderError("Claude declined this request.");
  if (message.stop_reason === "max_tokens") throw new ProviderError("Claude's reply was cut off. The note may be too long.");
  const text = message.content.find((block) => block.type === "text")?.text;
  return parseJsonReply(text, "Claude");
}

function describe(e: unknown): unknown {
  if (e instanceof Anthropic.AuthenticationError) return new ProviderError("The Anthropic API key was rejected.");
  if (e instanceof Anthropic.NotFoundError) return new ProviderError("Claude API: model not found.");
  if (e instanceof Anthropic.RateLimitError) return new ProviderError("Claude API rate limit reached. Try again shortly.");
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError("Couldn't reach the Claude API.");
  if (e instanceof Anthropic.APIError) return new ProviderError(`Claude API: ${e.message}`);
  return e;
}

export function anthropic(opts: AnthropicOptions): Provider {
  return {
    name: "Claude",
    run(request) {
      if (!opts.apiKey) return failedRun("Add your Anthropic API key in the Margin Prompt settings.");
      const model = opts.model || ANTHROPIC_DEFAULT_MODEL;
      // Obsidian runs plugins in a browser window; the key only ever goes to Anthropic.
      const client = new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
      const effort = opts.effort && !NO_EFFORT_MODELS.has(model) ? (opts.effort as Effort) : undefined;

      return abortableRun(request.timeoutMs, (signal) =>
        client.beta.messages
          .create(
            {
              model,
              max_tokens: 16000,
              system: request.system,
              messages: [{ role: "user", content: request.prompt }],
              output_config: {
                format: { type: "json_schema", schema: request.schema as Record<string, unknown> },
                ...(effort ? { effort } : {}),
              },
              ...(FALLBACK_MODELS.has(model)
                ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
                : {}),
            },
            { signal, timeout: request.timeoutMs },
          )
          .then(readMessage, (e) => {
            throw signal.aborted ? e : describe(e);
          }),
      );
    },
  };
}
