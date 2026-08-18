import { execSync } from "child_process";

export interface RawContext {
  git_log: string;
  git_diff: string;
}

export function gatherGitContext(): RawContext {
  const run = (cmd: string): string => {
    try {
      return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return "";
    }
  };

  const git_log = run("git log --oneline -10");
  const rawDiff = run("git diff HEAD~1 HEAD --stat --unified=3");
  // Cap diff at ~15 KB — large commits (new files) exceed LLM JSON-output limits.
  const MAX_DIFF = 15_000;
  const git_diff =
    rawDiff.length > MAX_DIFF
      ? rawDiff.slice(0, MAX_DIFF) + "\n\n[diff truncated — showing first 15 KB of a larger change]"
      : rawDiff;

  if (!git_log && !git_diff) {
    throw new Error(
      "No git context found. Make sure you are inside a git repository with at least one commit."
    );
  }

  return { git_log, git_diff };
}
