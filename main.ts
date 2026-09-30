import {
  App,
  Editor,
  FileSystemAdapter,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import { applyChanges, Edit, findComments, planChanges, PlanError } from "./comments";
import { buildPrompt, Instruction, readReply, REPLY_SCHEMA, SYSTEM_PROMPT } from "./prompt";
import { ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_MODELS, anthropic } from "./providers/anthropic";
import { claudeCode, resolveBinary } from "./providers/claude-code";
import { OLLAMA_URL, ollama } from "./providers/ollama";
import { OPENAI_BASE_URL, openai } from "./providers/openai";
import type { Provider, ProviderRun } from "./providers/provider";

type ProviderId = "claude-code" | "anthropic" | "openai" | "ollama";

interface MarginPromptSettings {
  provider: ProviderId;
  claudePath: string; // Claude Code: empty = auto-detect
  model: string; // Claude Code: empty = its default
  effort: string; // Claude Code and Claude API: empty = the model's default
  anthropicKey: string;
  anthropicModel: string;
  openaiBaseUrl: string; // empty = OpenAI; e.g. https://api.x.ai/v1 for Grok
  openaiKey: string;
  openaiModel: string;
  ollamaUrl: string; // empty = http://localhost:11434
  ollamaModel: string;
  commentPrefix: string; // empty = every comment is a prompt
  removeComments: boolean;
  allowVaultReads: boolean;
  timeoutSeconds: number;
}

const DEFAULT_SETTINGS: MarginPromptSettings = {
  provider: "claude-code",
  claudePath: "",
  model: "",
  effort: "",
  anthropicKey: "",
  anthropicModel: ANTHROPIC_DEFAULT_MODEL,
  openaiBaseUrl: "",
  openaiKey: "",
  openaiModel: "",
  ollamaUrl: "",
  ollamaModel: "",
  commentPrefix: "",
  removeComments: true,
  allowVaultReads: false,
  timeoutSeconds: 180,
};

const PROVIDERS: Record<ProviderId, string> = {
  "claude-code": "Claude Code (your Claude subscription)",
  anthropic: "Claude API (Anthropic API key)",
  openai: "OpenAI-compatible API (ChatGPT, Grok, …)",
  ollama: "Ollama (local models)",
};

// Values for claude's --model and --effort; "" leaves the choice to your Claude Code default.
const MODELS: Record<string, string> = {
  "": "Claude Code default",
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku (fastest)",
};
const EFFORTS: Record<string, string> = {
  "": "Claude Code default",
  low: "Low (fastest)",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

type TextSettingKey = {
  [K in keyof MarginPromptSettings]: string extends MarginPromptSettings[K] ? K : never; // free-text fields only
}[keyof MarginPromptSettings];

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export default class MarginPromptPlugin extends Plugin {
  settings: MarginPromptSettings;
  private running = new Map<string, ProviderRun>(); // note path → its in-flight request

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new MarginPromptSettingTab(this.app, this));

    this.addCommand({
      id: "run-prompts",
      name: "Run prompts in current note",
      editorCallback: (editor, ctx) => {
        if (ctx.file) void this.run(ctx.file, editor);
      },
    });

    this.addCommand({
      id: "cancel-prompts",
      name: "Cancel running prompts",
      checkCallback: (checking) => {
        if (this.running.size === 0) return false;
        if (!checking) this.cancelAll();
        return true;
      },
    });
  }

  onunload(): void {
    this.cancelAll();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  cancelAll(): void {
    for (const run of this.running.values()) run.cancel();
  }

  /**
   * Send the note's prompt comments to the model and apply the edits it
   * returns. With no prompt comments, ask for a prompt in a text box instead.
   */
  async run(file: TFile, editor: Editor): Promise<void> {
    if (this.running.has(file.path)) {
      new Notice("Already working on this note.");
      return;
    }

    const comments = findComments(editor.getValue(), this.settings.commentPrefix.trim());
    if (comments.length > 0) {
      await this.ask(file, editor, comments, comments.map((c) => c.raw));
      return;
    }

    new PromptModal(this.app, this.provider().name, (prompt) => {
      const pos = editor.getCursor();
      const instruction = { prompt, line: pos.line + 1, column: pos.ch + 1, typed: true };
      void this.ask(file, editor, [instruction], [], editor.posToOffset(pos));
    }).open();
  }

  /**
   * Run the model on the note with `instructions`. `raws[i]` is the comment behind
   * instruction i + 1 (typed prompts have none), removed once it's carried out.
   * `cursor` is where edits with an empty old_text go.
   */
  private async ask(
    file: TFile,
    editor: Editor,
    instructions: Instruction[],
    raws: string[],
    cursor?: number,
  ): Promise<void> {
    if (this.running.has(file.path)) {
      new Notice("Already working on this note.");
      return;
    }
    const provider = this.provider();
    const doc = editor.getValue();
    const vaultPath = this.settings.allowVaultReads ? this.vaultPath() : null;
    const run = provider.run({
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(file.path, doc, instructions, vaultPath),
      schema: REPLY_SCHEMA,
      readableDir: vaultPath,
      timeoutMs: this.settings.timeoutSeconds * 1000,
    });
    this.running.set(file.path, run);
    const progress = new Notice(`${provider.name} is working on ${plural(instructions.length, "prompt")}…`, 0);

    try {
      const { edits, skipped, summary } = readReply(await run.reply);
      const done = raws.filter((_, i) => !skipped.includes(i + 1));
      const changed = await this.apply(file, edits, done, cursor);
      const skippedNote = skipped.length
        ? ` Skipped ${plural(skipped.length, "prompt")}` +
          (raws.length ? `; ${skipped.length === 1 ? "its comment was" : "their comments were"} kept.` : ".")
        : "";
      new Notice(
        (changed ? `${provider.name}: ${summary}` : `${provider.name} made no changes. ${summary}`) + skippedNote,
        skipped.length ? 15000 : 8000,
      );
    } catch (e) {
      console.error("Margin Prompt:", e);
      const message = e instanceof Error ? e.message : String(e);
      new Notice(
        e instanceof PlanError
          ? `${provider.name}'s edits didn't fit the note, so nothing was changed. ${message}`
          : `${provider.name}: ${message}`,
        10000,
      );
    } finally {
      progress.hide();
      this.running.delete(file.path);
    }
  }

  /**
   * Apply edits through the note's open editor if there is one (a single undo
   * step), otherwise to the file on disk. Returns how many changes were made.
   */
  private async apply(file: TFile, edits: Edit[], done: string[], cursor?: number): Promise<number> {
    const plan = (doc: string) => planChanges(doc, edits, done, this.settings.removeComments, cursor);

    const editor = this.openEditor(file);
    if (editor) {
      const changes = plan(editor.getValue());
      if (changes.length > 0) {
        editor.transaction({
          changes: changes.map((c) => ({
            from: editor.offsetToPos(c.from),
            to: editor.offsetToPos(c.to),
            text: c.text,
          })),
        });
      }
      return changes.length;
    }

    let count = 0;
    await this.app.vault.process(file, (data) => {
      const changes = plan(data);
      count = changes.length;
      return applyChanges(data, changes);
    });
    return count;
  }

  private openEditor(file: TFile): Editor | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === file.path) return view.editor;
    }
    return null;
  }

  /** The LLM backend chosen in the settings. Each lives in providers/. */
  private provider(): Provider {
    const s = this.settings;
    switch (s.provider) {
      case "anthropic":
        return anthropic({ apiKey: s.anthropicKey, model: s.anthropicModel, effort: s.effort });
      case "openai":
        return openai({ baseUrl: s.openaiBaseUrl, apiKey: s.openaiKey, model: s.openaiModel });
      case "ollama":
        return ollama({ url: s.ollamaUrl, model: s.ollamaModel });
      default:
        return claudeCode({ binary: s.claudePath, model: s.model.trim(), effort: s.effort });
    }
  }

  private vaultPath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }
}

/** A text box for a one-off prompt. Enter runs it, Shift+Enter adds a line, and a blank prompt does nothing. */
class PromptModal extends Modal {
  constructor(app: App, private modelName: string, private onSubmit: (prompt: string) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(`Ask ${this.modelName} about this note`);
    this.contentEl.createEl("p", {
      text: `No prompt comments found. What should ${this.modelName} do? Enter to run, Shift+Enter for a new line.`,
      cls: "setting-item-description",
    });
    const input = this.contentEl.createEl("textarea", { attr: { rows: "4" } });
    input.style.width = "100%";
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      const prompt = input.value.trim();
      if (!prompt) return;
      this.close();
      this.onSubmit(prompt);
    });
    input.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class MarginPromptSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: MarginPromptPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();

    const textSetting = (name: string, desc: string, key: TextSettingKey, placeholder: string, secret = false) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) => {
          if (secret) text.inputEl.type = "password";
          text
            .setPlaceholder(placeholder)
            .setValue(settings[key])
            .onChange(async (value) => {
              settings[key] = value.trim();
              await save();
            });
        });
    const effortSetting = () =>
      new Setting(containerEl)
        .setName("Effort")
        .setDesc("How much Claude thinks before answering. Lower is faster; Haiku ignores this.")
        .addDropdown((dropdown) =>
          dropdown
            .addOptions(EFFORTS)
            .setValue(settings.effort)
            .onChange(async (value) => {
              settings.effort = value;
              await save();
            }),
        );

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Which LLM carries out your prompts.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(PROVIDERS)
          .setValue(settings.provider)
          .onChange(async (value) => {
            settings.provider = value as ProviderId;
            await save();
            this.display(); // show the chosen provider's settings
          }),
      );

    if (settings.provider === "claude-code") {
      textSetting(
        "Claude Code path",
        `Full path to the claude binary (run "which claude" in a terminal). ` +
          `Leave empty to auto-detect; currently using ${resolveBinary(settings.claudePath)}.`,
        "claudePath",
        "~/.local/bin/claude",
      );
      new Setting(containerEl)
        .setName("Model")
        .setDesc("Which Claude model to use. Faster models suit quick edits.")
        .addDropdown((dropdown) => {
          dropdown.addOptions(MODELS);
          // Keep a model name typed in an earlier version selectable.
          if (!(settings.model in MODELS)) dropdown.addOption(settings.model, settings.model);
          dropdown.setValue(settings.model).onChange(async (value) => {
            settings.model = value;
            await save();
          });
        });
      effortSetting();
    }

    if (settings.provider === "anthropic") {
      textSetting(
        "API key",
        "From console.anthropic.com. Stored in this plugin's data.json in your vault.",
        "anthropicKey",
        "sk-ant-…",
        true,
      );
      new Setting(containerEl).setName("Model").addDropdown((dropdown) =>
        dropdown
          .addOptions(ANTHROPIC_MODELS)
          .setValue(settings.anthropicModel)
          .onChange(async (value) => {
            settings.anthropicModel = value;
            await save();
          }),
      );
      effortSetting();
    }

    if (settings.provider === "openai") {
      textSetting(
        "Base URL",
        `Leave empty for OpenAI (${OPENAI_BASE_URL}). For Grok use https://api.x.ai/v1; any server with an OpenAI-style /chat/completions works.`,
        "openaiBaseUrl",
        OPENAI_BASE_URL,
      );
      textSetting(
        "API key",
        "From your provider's dashboard. Stored in this plugin's data.json in your vault.",
        "openaiKey",
        "sk-…",
        true,
      );
      textSetting("Model", "The model id your provider lists, e.g. for OpenAI or xAI.", "openaiModel", "model id");
    }

    if (settings.provider === "ollama") {
      textSetting("Server URL", `Leave empty for ${OLLAMA_URL}.`, "ollamaUrl", OLLAMA_URL);
      textSetting(
        "Model",
        'A model you\'ve pulled (run "ollama list" to see them). Larger models copy text more reliably.',
        "ollamaModel",
        "llama3.2",
      );
    }

    new Setting(containerEl).setName("Prompts").setHeading();

    new Setting(containerEl)
      .setName("Comment prefix")
      .setDesc(
        'Only treat comments that start with this as prompts, e.g. "ai:" for %% ai: fix typos %%. ' +
          "Leave empty to treat every comment as a prompt.",
      )
      .addText((text) =>
        text
          .setPlaceholder("none")
          .setValue(settings.commentPrefix)
          .onChange(async (value) => {
            settings.commentPrefix = value;
            await save();
          }),
      );

    new Setting(containerEl)
      .setName("Remove comments when done")
      .setDesc("Delete each prompt comment once it has been carried out. Skipped prompts' comments are kept.")
      .addToggle((toggle) =>
        toggle.setValue(settings.removeComments).onChange(async (value) => {
          settings.removeComments = value;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("Let the model read other notes")
      .setDesc(
        'Give the model read-only access to the vault so prompts like "summarize [[Another note]] here" work. ' +
          "Claude Code only; slower, since it may look around first.",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.allowVaultReads).onChange(async (value) => {
          settings.allowVaultReads = value;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("Timeout (seconds)")
      .setDesc("Stop waiting for the model after this long.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.timeoutSeconds))
          .setValue(String(settings.timeoutSeconds))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (n > 0) {
              settings.timeoutSeconds = n;
              await save();
            }
          }),
      );
  }
}
