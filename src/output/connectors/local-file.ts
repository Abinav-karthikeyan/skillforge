import { mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { stringify } from "yaml";
import { SessionSummary, TranslatorOutput } from "../../types/session.js";
import { renderMarkdown } from "../renderer.js";
import { CareerModeConnector } from "./types.js";
import { registerConnector } from "./registry.js";
import { resolveArtifactsDir } from "../../config/paths.js";

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
    this.outputDir = resolveArtifactsDir(outputDir);
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
    // Serialize via the YAML library rather than hand-building the string: a
    // one_liner containing a quote, colon, or newline would otherwise corrupt
    // the index that `readLastArtifact` parses back. Each entry is emitted as a
    // single-element sequence (`- key: …`); appended blocks concatenate into
    // one valid YAML sequence, preserving the per-write append semantics.
    const entry = stringify([
      {
        session_id: session.session_id,
        mode: output.mode,
        timestamp: output.timestamp,
        file: filename,
        one_liner: session.summary.one_liner,
      },
    ]);

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
