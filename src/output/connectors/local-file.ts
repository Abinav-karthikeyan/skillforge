import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { SessionSummary, TranslatorOutput } from "../../types/session.js";
import { renderMarkdown } from "../renderer.js";
import { CareerModeConnector } from "./types.js";
import { registerConnector } from "./registry.js";

function resolveOutputDir(outputDir?: string): string {
  const dir = outputDir ?? "~/.career-mode/artifacts";
  return dir.startsWith("~") ? join(homedir(), dir.slice(2)) : dir;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function buildFilename(output: TranslatorOutput, session: SessionSummary): string {
  const date = output.timestamp.slice(0, 10);
  const slug = slugify(session.summary.one_liner);
  return `${date}-${output.mode}-${slug}.md`;
}

export class LocalFileConnector implements CareerModeConnector {
  private outputDir: string;

  constructor(outputDir?: string) {
    this.outputDir = resolveOutputDir(outputDir);
  }

  async write(output: TranslatorOutput, session: SessionSummary): Promise<string> {
    mkdirSync(this.outputDir, { recursive: true });

    const filename = buildFilename(output, session);
    const filepath = join(this.outputDir, filename);
    const markdown = renderMarkdown(output, session);

    writeFileSync(filepath, markdown, "utf-8");
    this.updateIndex(output, session, filename);

    return filepath;
  }

  private updateIndex(
    output: TranslatorOutput,
    session: SessionSummary,
    filename: string
  ): void {
    const indexPath = join(this.outputDir, "index.yml");
    const entry = [
      `- session_id: ${session.session_id}`,
      `  mode: ${output.mode}`,
      `  timestamp: ${output.timestamp}`,
      `  file: ${filename}`,
      `  one_liner: "${session.summary.one_liner.replace(/"/g, '\\"')}"`,
      "",
    ].join("\n");

    appendFileSync(indexPath, entry, "utf-8");
  }
}

registerConnector({
  name: "local",
  secretFields: [],
  alwaysWriteLocal: false,
  create(config) {
    return new LocalFileConnector(config.output_dir);
  },
});
