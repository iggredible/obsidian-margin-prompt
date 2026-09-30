// What every LLM backend implements. The plugin builds a request (see ../prompt.ts),
// a provider sends it to its model, and returns the model's structured reply.

export interface ProviderRequest {
  system: string;
  prompt: string;
  schema: object; // JSON Schema the reply must match
  readableDir: string | null; // a folder the model may read from, if the provider supports it
  timeoutMs: number;
}

export interface ProviderRun {
  reply: Promise<unknown>; // the parsed JSON object matching `schema`
  cancel(): void;
}

export interface Provider {
  name: string; // shown in notices, e.g. "Claude"
  run(request: ProviderRequest): ProviderRun;
}

/** A failure worth showing the user as-is (not logged in, timed out, cancelled…). */
export class ProviderError extends Error {}

/**
 * Wrap an abortable request as a ProviderRun: cancel() and the timeout both
 * abort it, and the rejection says which happened.
 */
export function abortableRun(timeoutMs: number, start: (signal: AbortSignal) => Promise<unknown>): ProviderRun {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const reply = start(controller.signal)
    .catch((e) => {
      if (!controller.signal.aborted) throw e;
      throw new ProviderError(timedOut ? `Timed out after ${timeoutMs / 1000}s.` : "Cancelled.");
    })
    .finally(() => clearTimeout(timer));
  return { reply, cancel: () => controller.abort() };
}

/** A run that fails straight away, e.g. when a required setting is missing. */
export function failedRun(message: string): ProviderRun {
  return { reply: Promise.reject(new ProviderError(message)), cancel: () => {} };
}

/** Parse a model's JSON text reply, with a readable error if it isn't JSON. */
export function parseJsonReply(text: string | null | undefined, modelName: string): unknown {
  if (!text) throw new ProviderError(`${modelName} returned an empty reply.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`${modelName} didn't reply with valid JSON.`);
  }
}
