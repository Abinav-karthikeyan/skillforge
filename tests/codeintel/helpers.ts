import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

/** Throwaway git repositories for code-intelligence tests. */
export class TempRepo {
  readonly root: string;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), "sf-codeintel-"));
    this.git("init", "-q");
    this.git("config", "core.autocrlf", "false");
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: this.root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  write(files: Record<string, string>): this {
    for (const [path, content] of Object.entries(files)) {
      const full = join(this.root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf-8");
    }
    return this;
  }

  remove(...paths: string[]): this {
    for (const p of paths) rmSync(join(this.root, p), { force: true });
    return this;
  }

  commit(message: string): this {
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
    return this;
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
