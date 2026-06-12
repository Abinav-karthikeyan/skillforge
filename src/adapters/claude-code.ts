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
  const git_diff = run("git diff HEAD~1 HEAD --stat --unified=3");

  if (!git_log && !git_diff) {
    throw new Error(
      "No git context found. Make sure you are inside a git repository with at least one commit."
    );
  }

  return { git_log, git_diff };
}
