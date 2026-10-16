import { createClient, ProviderConfig } from "../claude/client.js";
import { LLMClient } from "../claude/types.js";
import { loadCalibration } from "../config/calibration.js";
import { resolveArtifactsDir } from "../config/paths.js";
import { StoryLedger } from "../ledger/store.js";
import { generateArtifacts, GenerateResult } from "../pipeline/generate.js";
import { CalibrationConfig } from "../types/config.js";
import { projectStory, Story } from "../types/ledger.js";
import { TranslationMode } from "../types/session.js";
import { Journal } from "./journal.js";

/**
 * The review inbox (plan_v3 §3.3 interaction contract): observer stories wait
 * as candidates until the user approves or discards them. Approval is the
 * only path to an artifact — nothing is published on the observer's say-so.
 */
export interface InboxDeps {
  config?: CalibrationConfig;
  ledger?: StoryLedger;
  journal?: Journal;
  client?: LLMClient;
}

function resolve(deps: InboxDeps) {
  const config = deps.config ?? loadCalibration();
  return {
    config,
    ledger: deps.ledger ?? StoryLedger.forArtifactsDir(resolveArtifactsDir(config.output_dir)),
    journal: deps.journal ?? new Journal(),
  };
}

export function listCandidates(deps: InboxDeps = {}): Story[] {
  const { ledger } = resolve(deps);
  return ledger
    .list()
    .filter((s) => s.status === "candidate")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function refreshCount(ledger: StoryLedger, journal: Journal): void {
  try {
    journal.writeInboxCount(ledger.list().filter((s) => s.status === "candidate").length);
  } catch {
    /* the counter is a convenience for notify; never fail the action over it */
  }
}

export function discardStory(storyId: string, deps: InboxDeps = {}): Story {
  const { ledger, journal } = resolve(deps);
  const story = ledger.setStatus(storyId, "discarded");
  refreshCount(ledger, journal);
  return story;
}

/**
 * Approve a candidate and (optionally) render it in the given modes through
 * the configured connector. The story keeps its id, so later reflections
 * update the same living artifacts.
 */
export async function approveStory(
  storyId: string,
  modes: TranslationMode[] | false,
  deps: InboxDeps = {}
): Promise<{ story: Story; generated?: GenerateResult }> {
  const { config, ledger, journal } = resolve(deps);
  const story = ledger.setStatus(storyId, "approved");
  refreshCount(ledger, journal);
  if (!modes || modes.length === 0) return { story };
  if (!story.summary) throw new Error(`Story "${storyId}" has no summary to render.`);
  const client =
    deps.client ??
    createClient({ provider: config.provider, model: config.model, base_url: config.base_url, api_key: config.api_key } as ProviderConfig);
  const generated = await generateArtifacts(client, config, projectStory(story), modes);
  return { story: ledger.get(storyId) ?? story, generated };
}

/** A compact, human-readable line per candidate (CLI + MCP). */
export function describeCandidate(s: Story, observationCount?: number): string {
  const kinds = s.summary
    ? [s.summary.tradeoffs.length ? `${s.summary.tradeoffs.length} tradeoff(s)` : "", s.summary.dead_ends.length ? `${s.summary.dead_ends.length} dead end(s)` : ""]
        .filter(Boolean)
        .join(", ")
    : "";
  const facts = s.code_facts ? `, ${s.code_facts.classification} · ${s.code_facts.files_changed} files` : "";
  return `${s.story_id}  v${s.version}  ${s.title}${kinds || facts ? `  (${[kinds, facts.replace(/^, /, "")].filter(Boolean).join(", ")})` : ""}${
    observationCount !== undefined ? `  [${observationCount} observations]` : ""
  }`;
}
