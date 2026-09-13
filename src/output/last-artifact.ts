import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import { resolveArtifactsDir } from "../config/paths.js";

export interface LastArtifact {
  filename: string;
  filepath: string;
  markdown: string;
  entry: {
    session_id: string;
    mode: string;
    timestamp: string;
    file: string;
    one_liner: string;
  };
}

/**
 * Reads index.yml from the artifacts dir, returns the most recently written entry
 * along with its rendered markdown. Throws with a helpful message if no artifacts exist.
 */
export function readLastArtifact(outputDir?: string): LastArtifact {
  const resolved = resolveArtifactsDir(outputDir);
  const indexPath = join(resolved, "index.yml");

  let indexRaw: string;
  try {
    indexRaw = readFileSync(indexPath, "utf-8");
  } catch {
    throw new Error(
      `No artifacts index found at ${indexPath}. Run \`career-mode generate\` first.`
    );
  }

  // index.yml is written as a flat sequence of `- session_id: ... ...` entries.
  const entries = parse(indexRaw) as LastArtifact["entry"][] | null;
  if (!entries || entries.length === 0) {
    throw new Error(`Artifacts index at ${indexPath} is empty. Nothing to share.`);
  }

  const entry = entries[entries.length - 1];
  const filepath = join(resolved, entry.file);
  const markdown = readFileSync(filepath, "utf-8");
  return { filename: entry.file, filepath, markdown, entry };
}
