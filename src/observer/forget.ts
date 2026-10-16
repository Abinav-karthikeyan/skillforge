import { StoryLedger } from "../ledger/store.js";
import { Journal } from "./journal.js";
import { normalizeRepoPath } from "./settings.js";

/**
 * `skill-forge forget --session <id> | --repo <path>` (plan_v3 §3.4): delete
 * the raw journal, the observations, and the observer-made stories that came
 * only from the forgotten sessions. Stories the user generated explicitly
 * (origin "generate") are left alone — they are the user's own artifacts.
 */
export interface ForgetResult {
  sessions: string[];
  stories: string[];
}

export function sessionsForRepo(journal: Journal, repo: string): string[] {
  const key = normalizeRepoPath(repo);
  return journal
    .allStates()
    .filter((s) => s.repo && normalizeRepoPath(s.repo) === key)
    .map((s) => s.session_id);
}

export function forgetSessions(sessionIds: string[], journal: Journal, ledger: StoryLedger): ForgetResult {
  const gone = new Set(sessionIds);
  for (const id of gone) {
    journal.remove(id);
    ledger.removeObservations(id);
  }
  const stories: string[] = [];
  for (const story of ledger.list()) {
    if (story.origin !== "observer") continue;
    if (story.session_ids.length > 0 && story.session_ids.every((s) => gone.has(s))) {
      ledger.delete(story.story_id);
      stories.push(story.story_id);
    }
  }
  journal.writeInboxCount(ledger.list().filter((s) => s.status === "candidate").length);
  return { sessions: [...gone], stories };
}
