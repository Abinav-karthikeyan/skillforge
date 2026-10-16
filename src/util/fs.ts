import { createHash } from "crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";

/**
 * Write a file via a temp sibling + rename, so a crash mid-write never leaves
 * a half-written index or story behind. Creates the parent directory.
 */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf-8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Make an arbitrary id safe to use as a filename stem. Ids that needed
 * rewriting get a short hash suffix so "a/b" and "a_b" never collide.
 */
export function safeFileStem(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 80);
  if (cleaned === id && cleaned.length > 0) return cleaned;
  const hash = createHash("sha1").update(id).digest("hex").slice(0, 8);
  return `${cleaned || "_"}-${hash}`;
}
