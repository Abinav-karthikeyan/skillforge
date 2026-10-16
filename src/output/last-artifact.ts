import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { resolveArtifactsDir } from "../config/paths.js";
import { IndexEntry, indexPath, readIndex } from "./index-file.js";

export interface LastArtifact {
  filename: string;
  filepath: string;
  markdown: string;
  entry: IndexEntry;
}

/**
 * Reads index.yml from the artifacts dir, returns the most recently written entry
 * along with its rendered markdown. Throws with a helpful message if no artifacts exist.
 * Story upserts move their entry to the end of the index, so the tail is always
 * the latest write.
 */
export function readLastArtifact(outputDir?: string): LastArtifact {
  const resolved = resolveArtifactsDir(outputDir);
  const path = indexPath(resolved);

  if (!existsSync(path)) {
    throw new Error(
      `No artifacts index found at ${path}. Run \`skill-forge generate\` first.`
    );
  }

  const entries = readIndex(resolved);
  if (entries.length === 0) {
    throw new Error(`Artifacts index at ${path} is empty. Nothing to share.`);
  }

  const entry = entries[entries.length - 1];
  const filepath = join(resolved, entry.file);
  const markdown = readFileSync(filepath, "utf-8");
  return { filename: entry.file, filepath, markdown, entry };
}
