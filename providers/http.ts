// POST JSON with Node's http(s) rather than the browser's fetch, so requests
// from inside Obsidian aren't subject to CORS (Ollama and some OpenAI-compatible
// servers don't allow Obsidian's origin).
import * as http from "http";
import * as https from "https";
import { ProviderError } from "./provider";

/** The error text in an API's error body: `{error: {message}}` (OpenAI, Anthropic) or `{error: "…"}` (Ollama). */
function errorMessage(body: any): string | undefined {
  if (typeof body?.error === "string") return body.error;
  if (typeof body?.error?.message === "string") return body.error.message;
  return undefined;
}

export function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;
    const req = client.request(
      target,
      { method: "POST", headers: { "content-type": "application/json", ...headers }, signal },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          let json: any;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          const status = res.statusCode ?? 0;
          if (status >= 400) return reject(new ProviderError(errorMessage(json) ?? `HTTP ${status} from ${target.host}.`));
          if (json === undefined) return reject(new ProviderError(`${target.host} didn't return JSON.`));
          resolve(json);
        });
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      reject(err.code === "ECONNREFUSED" ? new ProviderError(`Couldn't connect to ${target.origin}. Is it running?`) : err);
    });
    req.end(JSON.stringify(body));
  });
}
