// Claude through Claude Code's headless mode (`claude -p`).
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Provider, ProviderError, ProviderRequest, ProviderRun } from "./provider";

export interface ClaudeCodeOptions {
  binary: string; // empty = auto-detect
  model: string; // empty = the user's Claude Code default
  effort: string; // empty = the user's Claude Code default
}

const READ_ONLY_TOOLS = "Read,Glob,Grep";

/** The claude binary to run: the configured path, else the first standard install location found. */
export function resolveBinary(configured: string): string {
  const home = os.homedir();
  if (configured.trim()) return configured.trim().replace(/^~(?=\/)/, home);
  const candidates = [
    path.join(home, ".local/bin/claude"),
    path.join(home, ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? "claude";
}

// Apps launched from the Dock get a bare PATH, so add the usual install dirs
// (npm installs of claude also need `node` on PATH).
function spawnEnv(binary: string): NodeJS.ProcessEnv {
  const dirs = [path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  if (path.isAbsolute(binary)) dirs.unshift(path.dirname(binary));
  return { ...process.env, PATH: [...dirs, process.env.PATH ?? ""].join(path.delimiter) };
}

/** Pull the structured reply out of the stdout of `claude -p --output-format json --json-schema …`. */
export function parseOutput(stdout: string): unknown {
  let out: any;
  try {
    out = JSON.parse(stdout);
  } catch {
    throw new ProviderError(stdout.trim() || "Claude Code returned no output.");
  }
  if (out.is_error) throw new ProviderError(out.result || `Claude Code failed (${out.subtype}).`);
  if (!out.structured_output) throw new ProviderError("Claude Code returned no structured reply.");
  return out.structured_output;
}

/**
 * Runs `claude -p` with the prompt on stdin, outside the vault so the vault's
 * CLAUDE.md and project settings don't apply, with no MCP servers or hooks,
 * and with no tools unless `readableDir` grants read-only ones.
 */
export function claudeCode(opts: ClaudeCodeOptions): Provider {
  const binary = resolveBinary(opts.binary);
  return {
    name: "Claude",
    run(request: ProviderRequest): ProviderRun {
      const args = [
        "-p",
        "--output-format", "json",
        "--json-schema", JSON.stringify(request.schema),
        "--system-prompt", request.system,
        "--no-session-persistence",
        "--strict-mcp-config",
        "--settings", JSON.stringify({ disableAllHooks: true }),
      ];
      if (opts.model) args.push("--model", opts.model);
      if (opts.effort) args.push("--effort", opts.effort);
      if (request.readableDir) {
        args.push("--tools", READ_ONLY_TOOLS, "--allowedTools", READ_ONLY_TOOLS, "--add-dir", request.readableDir);
      } else {
        args.push("--tools", "");
      }

      const child = spawn(binary, args, { cwd: os.tmpdir(), env: spawnEnv(binary) });

      const reply = new Promise<unknown>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        child.stdout?.on("data", (d) => (stdout += d));
        child.stderr?.on("data", (d) => (stderr += d));
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, request.timeoutMs);

        child.on("error", (err: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          reject(
            err.code === "ENOENT"
              ? new ProviderError(`Couldn't find Claude Code at "${binary}". Set its path in the plugin settings.`)
              : err,
          );
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          if (timedOut) return reject(new ProviderError(`Timed out after ${request.timeoutMs / 1000}s.`));
          if (signal) return reject(new ProviderError("Cancelled."));
          try {
            resolve(parseOutput(stdout));
          } catch (e) {
            const failure = code === 0 ? "" : stderr.trim().split("\n").slice(-3).join(" ");
            reject(failure && !stdout.trim() ? new ProviderError(failure) : e);
          }
        });

        child.stdin?.on("error", () => {}); // EPIPE if claude exits early; "close" reports why
        child.stdin?.end(request.prompt);
      });

      return { reply, cancel: () => child.kill() };
    },
  };
}
