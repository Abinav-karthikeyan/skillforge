import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { SessionSummary, TranslatorOutput } from "../../types/session.js";
import { renderMarkdown } from "../renderer.js";
import { CareerModeConnector } from "./types.js";
import { registerConnector } from "./registry.js";
import { resolveArtifactsDir } from "../../config/paths.js";
import { appendIndexEntry, IndexEntry, readIndex, writeIndex } from "../index-file.js";

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
    if (session.story_id) return this.writeStoryArtifact(output, session, session.story_id);

    const filename = buildFilename(output, session);
    const filepath = join(this.outputDir, filename);
    const markdown = renderMarkdown(output, session);

    writeFileSync(filepath, markdown, "utf-8");
    appendIndexEntry(this.outputDir, {
      session_id: session.session_id,
      mode: output.mode,
      timestamp: output.timestamp,
      file: filename,
      one_liner: session.summary.one_liner,
    });

    return filepath;
  }

  /**
   * Living-artifact path: upsert by (story_id, mode). The artifact keeps its
   * first filename so links stay stable; the superseded body is archived to
   * `versions/<stem>.v<N>.md` for diffing, and the index entry moves to the
   * end so "last artifact" still means the most recent write.
   *
   * Stamps `output.artifact_version` so callers that re-render the output
   * (return_only) produce the same frontmatter as the file on disk.
   */
  private writeStoryArtifact(
    output: TranslatorOutput,
    session: SessionSummary,
    storyId: string
  ): string {
    const entries = readIndex(this.outputDir);
    const at = entries.findIndex((e) => e.story_id === storyId && e.mode === output.mode);
    const previous = at >= 0 ? entries[at] : undefined;
    const version = previous ? (previous.version ?? 1) + 1 : 1;
    const filename = previous?.file ?? buildFilename(output, session);
    const filepath = join(this.outputDir, filename);

    if (previous && existsSync(filepath)) {
      const versionsDir = join(this.outputDir, "versions");
      mkdirSync(versionsDir, { recursive: true });
      const stem = filename.replace(/\.md$/, "");
      copyFileSync(filepath, join(versionsDir, `${stem}.v${previous.version ?? 1}.md`));
    }

    output.artifact_version = version;
    writeFileSync(filepath, renderMarkdown(output, session), "utf-8");

    const entry: IndexEntry = {
      session_id: session.session_id,
      mode: output.mode,
      timestamp: output.timestamp,
      file: filename,
      one_liner: session.summary.one_liner,
      story_id: storyId,
      version,
    };
    writeIndex(this.outputDir, [...entries.filter((_, i) => i !== at), entry]);
    return filepath;
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
