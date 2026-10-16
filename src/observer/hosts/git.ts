import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { onPath, str } from "./shared.js";
import { captureCommand, HostAdapter, InstallContext } from "./types.js";
import { findRepoRoot, normalizeRepoPath } from "../settings.js";

const repoKey = (repo: string) => createHash("sha1").update(normalizeRepoPath(repo)).digest("hex").slice(0, 10);

/**
 * The universal floor (plan_v3 §3.5): a git `post-commit` hook. It sees only
 * commits — no prompts or dead ends — but works in any repo with any editor.
 * Sessions are per repo per day (`git:<repo-hash>:<date>`). A commit another
 * host already journaled (Claude Code's PostToolUse fires for the same
 * commit) is dropped by the capture layer's commit registry.
 */
const BEGIN = "# >>> skill-forge observe >>>";
const END = "# <<< skill-forge observe <<<";
const CHAINED = "post-commit.skill-forge-chained";

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
  } catch {
    return "";
  }
}

/** The hooks directory git actually uses (honors core.hooksPath, e.g. husky). */
export function hooksDir(repo: string): string {
  const custom = git(repo, ["config", "--get", "core.hooksPath"]);
  if (custom) return isAbsolute(custom) ? custom : resolve(repo, custom);
  const dir = git(repo, ["rev-parse", "--git-path", "hooks"]);
  return dir ? resolve(repo, dir) : join(repo, ".git", "hooks");
}

function block(command: string): string {
  // Background + no stdin: a commit must never wait on (or be blocked by) capture.
  return [BEGIN, `if command -v skill-forge-observe >/dev/null 2>&1; then (${command} </dev/null >/dev/null 2>&1 &) ; fi`, END].join("\n");
}

const SH_SHEBANG = /^#!\s*(\/bin\/(ba|da|z)?sh|\/usr\/bin\/env\s+(ba|da|z)?sh)\b/;

export const gitAdapter: HostAdapter = {
  name: "git",
  label: "git post-commit (any editor)",
  confidence: "verified",
  docs: "https://git-scm.com/docs/githooks#_post_commit",
  parse(raw, ctx) {
    const cwd = str(raw.cwd) ?? ctx.cwd;
    const repo = findRepoRoot(cwd);
    if (!repo) return null;
    const [sha, subject] = git(repo, ["log", "-1", "--format=%H%x00%s"]).split("\0");
    if (!sha) return null;
    return {
      sessionId: `${repoKey(repo)}:${ctx.now.toISOString().slice(0, 10)}`,
      cwd: repo,
      events: [
        {
          kind: "commit",
          payload: { tool: "git", command: "git commit (post-commit hook)", ok: true, sha: sha.slice(0, 12), message: (subject ?? "").slice(0, 200) },
        },
      ],
    };
  },
  detect: () => onPath("git"),
  configPath: (ctx: InstallContext) => {
    const repo = findRepoRoot(ctx.projectDir);
    if (!repo) throw new Error(`${ctx.projectDir} is not inside a git repository`);
    return join(hooksDir(repo), "post-commit");
  },
  install(ctx) {
    const path = this.configPath(ctx);
    mkdirSync(join(path, ".."), { recursive: true });
    const ours = block(captureCommand("git", ctx));
    let script: string;
    if (!existsSync(path)) {
      script = `#!/bin/sh\n${ours}\n`;
    } else {
      const current = readFileSync(path, "utf-8");
      const stripped = current.replace(new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`), "\n");
      if (SH_SHEBANG.test(stripped) || !stripped.startsWith("#!")) {
        // A shell hook: append our block, keep theirs.
        script = `${stripped.replace(/\n*$/, "\n")}${ours}\n`;
      } else {
        // Another interpreter (node, python…): chain it, then run ours.
        const chained = join(path, "..", CHAINED);
        renameSync(path, chained);
        script = `#!/bin/sh\n"$(dirname "$0")/${CHAINED}" "$@"\nstatus=$?\n${ours}\nexit $status\n`;
      }
    }
    writeFileSync(path, script, "utf-8");
    try {
      chmodSync(path, 0o755);
    } catch {
      /* Windows: git runs hooks through its bundled sh regardless of mode */
    }
    return { path, events: ["post-commit"] };
  },
  uninstall(ctx) {
    const path = this.configPath(ctx);
    if (!existsSync(path)) return { path, removed: false };
    const current = readFileSync(path, "utf-8");
    if (!current.includes(BEGIN)) return { path, removed: false };
    const chained = join(path, "..", CHAINED);
    if (existsSync(chained)) {
      rmSync(path);
      renameSync(chained, path);
      return { path, removed: true };
    }
    const stripped = current.replace(new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`), "\n");
    if (stripped.replace(/^#!.*\n?/, "").trim() === "") rmSync(path);
    else writeFileSync(path, stripped, "utf-8");
    return { path, removed: true };
  },
};
