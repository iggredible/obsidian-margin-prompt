# Margin Prompt
Leave prompts in a note as comments, then run one command to have an LLM carry them out. For now the LLM is Claude, through Claude Code.

```md
%% Capitalize the block below %%
the quick brown fox
jumps over the lazy dog.

Some text with a tpyo. <!-- fix the typos in this line -->
```

Run **Margin Prompt: Run prompts in current note** from the command palette (assign a hotkey under Settings → Hotkeys). The plugin sends the note to `claude -p` (Claude Code's headless mode), applies the edits it returns as one undo step, and removes the comments it carried out. Comments inside code spans, code blocks and frontmatter are ignored.

If the note has no prompt comments, the command opens a text box instead. Type a prompt and press Enter to run it (Shift+Enter adds a line); "here" means the cursor, and Claude can insert right at it, so this works even in an empty note. A blank prompt does nothing, and Esc closes the box.

Requires Claude Code installed and logged in. Desktop only.

## Providers
Pick one under **Provider** in the settings; each shows its own settings.
- **Claude Code**: runs `claude -p` with your Claude subscription. The only provider that can read other notes.
- **Claude API**: an Anthropic API key and a model (Opus 5.5, Sonnet 5.5, Haiku 4.5, Fable 5.1).
- **OpenAI-compatible API**: base URL, API key and model id. Empty base URL means OpenAI (ChatGPT); `https://api.x.ai/v1` is Grok.
- **Ollama**: a local model you've pulled (`ollama list`). Small models are fast but less reliable at copying text exactly.

API keys are stored in the plugin's `data.json` inside the vault.

## Settings
- **Claude Code path**: auto-detected from the usual install locations; set it if yours lives elsewhere (`which claude`).
- **Model** and **Effort**: pick from dropdowns; Haiku or low effort for speed. "Claude Code default" uses whatever your Claude Code is set to.
- **Comment prefix**: e.g. `claude:` so only `%% claude: … %%` comments are prompts and your other comments are left alone.
- **Remove comments when done**: on by default. Comments Claude skips are always kept.
- **Let Claude read other notes**: read-only vault access, for prompts like "summarize [[Another note]] here".

## Code layout
- `main.ts`: the Obsidian side (commands, prompt box, settings, applying edits).
- `comments.ts`: finding prompt comments and turning the model's edits into changes.
- `prompt.ts`: the task, the same for every model: system prompt, reply schema, prompt text.
- `providers/`: one file per LLM backend, each implementing `Provider` from `providers/provider.ts`: `claude-code.ts`, `anthropic.ts`, `openai.ts`, `ollama.ts` (plus `http.ts`, shared by the last two).

## How the Claude Code provider runs Claude
`claude -p --output-format json --json-schema …` from a temp directory, with no tools (or only Read/Glob/Grep), no MCP servers, no hooks, and no saved session. Running outside the vault means the vault's `CLAUDE.md` and `.claude/settings.json` don't apply. Claude replies with `{old_text, new_text}` edits, which the plugin finds by text in the note (so typing while Claude works is fine) and applies all at once, or not at all if any don't match.

## Development
```sh
npm install
npm test        # comment parsing and edit planning
npm run build   # → main.js
cp main.js manifest.json ~/Documents/IggyNotes/.obsidian/plugins/margin-prompt/
```
