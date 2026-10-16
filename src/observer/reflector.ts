import { createHash } from "crypto";
import { z } from "zod";
import { callClaude, createClient, ProviderConfig } from "../claude/client.js";
import { LLMClient } from "../claude/types.js";
import { buildStructuralDigest } from "../codeintel/digest.js";
import { generateArtifacts, resolveModes } from "../pipeline/generate.js";
import { interpolate, loadPrompt } from "../translators/base.js";
import { CodeFacts } from "../types/code-facts.js";
import { projectStory, Story } from "../types/ledger.js";
import { SessionSummaryContentSchema, TranslationMode } from "../types/session.js";
import { CONFIDENTIAL_BLOCK, safeJson } from "./llm.js";
import { resolveDeps, runObserverPass, WorkerDeps } from "./worker.js";

/**
 * The cold path (plan_v3 §3.3): merge a session's observations into a story
 * (a candidate until the user approves it), attach code facts for the commits
 * the session made, and keep living artifacts current — an approved story
 * whose evidence changed has its artifacts regenerated in place (local
 * connector only; nothing is published without approval).
 */
const ReflectorResponseSchema = z.object({
  title: z.string().min(1).nullable(),
  summary: SessionSummaryContentSchema.omit({ code_facts: true, evidence: true, complexity_signals: true }).optional(),
});

export const storyIdForSession = (sessionId: string) => `obs-${sessionId}`;

export interface ReflectResult {
  story?: Story;
  changed?: boolean;
  regenerated?: string[];
  skipped?: string;
}

export interface ReflectOptions extends WorkerDeps {
  /** Regenerate artifacts of an approved story whose content changed (default true). */
  regenerate?: boolean;
  /** Client for regenerating artifacts (defaults to the main configured provider). */
  translatorClient?: LLMClient;
}

function hash(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex");
}

async function factsForCommits(repo: string | null, shas: string[]): Promise<CodeFacts | undefined> {
  if (!repo || shas.length === 0) return undefined;
  const first = shas[0];
  const last = shas[shas.length - 1];
  for (const range of [`${first}~1..${last}`, last]) {
    try {
      return (await buildStructuralDigest({ root: repo, range })).facts;
    } catch {
      /* root commit or rewritten history — try the narrower range */
    }
  }
  return undefined;
}

export async function reflectSession(sessionId: string, opts: ReflectOptions = {}): Promise<ReflectResult> {
  const d = resolveDeps(opts);
  let state = d.journal.loadState(sessionId);
  if (!state) return { skipped: "unknown session" };

  // Observe the tail first; the cold path must not lose the last turns.
  if (state.observed_through_seq < state.seq) await runObserverPass(sessionId, { ...opts, force: true });
  state = d.journal.loadState(sessionId) ?? state;

  const markReflected = () => {
    const unlock = d.journal.lockState(sessionId, 2_000);
    try {
      const latest = d.journal.loadState(sessionId) ?? state!;
      latest.reflected_through_seq = latest.seq;
      d.journal.saveState(latest);
    } finally {
      unlock?.();
    }
  };

  const observations = d.ledger.listObservations(sessionId);
  if (observations.length === 0) {
    markReflected();
    return { skipped: "no observations for this session" };
  }

  const events = d.journal.readEvents(sessionId);
  const prompts = events
    .filter((e) => e.kind === "prompt")
    .slice(0, 3)
    .map((e) => `- ${String(e.payload.text ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
  const shas = events.filter((e) => e.kind === "commit" && typeof e.payload.sha === "string").map((e) => e.payload.sha as string);
  const codeFacts = await factsForCommits(state.repo, shas);

  const { content: template } = loadPrompt("reflector");
  const system = interpolate(template, {
    experience_level: d.config.experience_level,
    confidential_block: state.confidential ? CONFIDENTIAL_BLOCK : "",
    prompts: prompts.join("\n") || "(none captured)",
    observations: observations
      .map((o) => `- [${o.kind}, confidence ${o.confidence}] ${o.claim}`)
      .join("\n"),
    code_facts: codeFacts ? JSON.stringify({ ...codeFacts, entity_changes: codeFacts.entity_changes.slice(0, 20) }) : "(no commits in this session)",
  });
  const client = d.clientFor(state.confidential);
  let parsed = ReflectorResponseSchema.safeParse(safeJson(await callClaude(client, system, "Write the story.")));
  if (!parsed.success) {
    parsed = ReflectorResponseSchema.safeParse(
      safeJson(await callClaude(client, system, "Write the story. Return ONLY the JSON object in the required shape."))
    );
  }
  if (!parsed.success) return { skipped: "reflector returned unparseable output" };
  if (!parsed.data.title || !parsed.data.summary) {
    markReflected();
    return { skipped: "observations too thin for a story" };
  }

  const nowIso = d.now().toISOString();
  const summary = SessionSummaryContentSchema.parse({ ...parsed.data.summary, ...(codeFacts ? { code_facts: codeFacts } : {}) });
  const storyId = storyIdForSession(sessionId);
  const existing = d.ledger.get(storyId);
  const observationIds = observations.map((o) => o.id);
  const evidenceIds = [...new Set(observations.flatMap((o) => o.evidence_ids))];

  let story: Story;
  let changed: boolean;
  if (!existing) {
    changed = true;
    story = d.ledger.put({
      story_id: storyId,
      title: parsed.data.title,
      status: "candidate",
      version: 1,
      created_at: nowIso,
      updated_at: nowIso,
      origin: "observer",
      source_tool: state.host,
      session_ids: [sessionId],
      observation_ids: observationIds,
      evidence_ids: evidenceIds,
      summary,
      code_facts: codeFacts,
      artifacts: [],
    });
  } else {
    changed =
      hash(existing.observation_ids) !== hash(observationIds) || hash(existing.summary) !== hash(summary);
    story = d.ledger.put({
      ...existing,
      title: parsed.data.title,
      version: changed ? existing.version + 1 : existing.version,
      updated_at: nowIso,
      observation_ids: observationIds,
      evidence_ids: evidenceIds,
      summary,
      code_facts: codeFacts ?? existing.code_facts,
    });
  }

  markReflected();
  d.journal.writeInboxCount(d.ledger.list().filter((s) => s.status === "candidate").length);

  // Living artifacts: only approved stories, only when something changed.
  const regenerated: string[] = [];
  if (story.status === "approved" && changed && opts.regenerate !== false && story.artifacts.length > 0) {
    const modes = [...new Set(story.artifacts.map((a) => a.mode))].flatMap((m) => resolveModes(m)) as TranslationMode[];
    const translator =
      opts.translatorClient ??
      createClient({ provider: d.config.provider, model: d.config.model, base_url: d.config.base_url, api_key: d.config.api_key } as ProviderConfig);
    const result = await generateArtifacts(translator, { ...d.config, connector: "local" }, projectStory(story), modes);
    regenerated.push(...result.artifacts.map((a) => a.location));
    story = d.ledger.get(storyId) ?? story;
  }
  return { story, changed, regenerated };
}

/**
 * Reflect every session whose reflection is behind: ended sessions, and
 * sessions idle for 6 h (crashed or abandoned). Also applies the raw-journal
 * retention TTL. Used by `skill-forge reflect` and SessionStart catch-up.
 */
export async function reflectPending(opts: ReflectOptions & { all?: boolean } = {}): Promise<Array<{ session: string } & ReflectResult>> {
  const d = resolveDeps(opts);
  const now = d.now().getTime();
  const results: Array<{ session: string } & ReflectResult> = [];
  for (const state of d.journal.allStates()) {
    if (state.reflected_through_seq >= state.seq) continue;
    const idle = now - Date.parse(state.updated_at) > 6 * 3_600_000;
    if (!opts.all && !state.ended && !idle) continue;
    try {
      results.push({ session: state.session_id, ...(await reflectSession(state.session_id, opts)) });
    } catch (err) {
      results.push({ session: state.session_id, skipped: `error: ${(err as Error).message}` });
    }
  }
  d.journal.purge(d.settings.retention_days, now);
  return results;
}
