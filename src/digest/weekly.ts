import { callClaude } from "../claude/client.js";
import { LLMClient } from "../claude/types.js";
import { buildStructuralDigest } from "../codeintel/digest.js";
import { git, isGitRepo } from "../codeintel/git.js";
import { resolveArtifactsDir } from "../config/paths.js";
import { loadAllStories } from "../ledger/migrate.js";
import { StoryLedger } from "../ledger/store.js";
import { reflectPending } from "../observer/reflector.js";
import { loadObserveSettings, ObserveSettings } from "../observer/settings.js";
import { createConnector } from "../output/connectors/factory.js";
import { formatReturnOnly, RETURN_ONLY } from "../output/return-only.js";
import { interpolate, loadPrompt } from "../translators/base.js";
import { CodeFacts } from "../types/code-facts.js";
import { CalibrationConfig } from "../types/config.js";
import { Story } from "../types/ledger.js";
import { SessionSummary, TranslatorOutput } from "../types/session.js";

/**
 * The scheduled weekly digest (v2 Bet 5 → plan_v3 Phase 3.5): the reflector's
 * schedule. It catches up on unreflected sessions, gathers the week's stories
 * and the code facts of each enabled repository's commits, writes a brag-doc
 * digest, and delivers it through any connector — `return_only` hands it to
 * a host agent (a Claude Code routine, say) to post wherever the user wants.
 */
export interface RepoWeek {
  repo: string;
  commits: number;
  facts?: CodeFacts;
}

export interface DigestInput {
  since: Date;
  until: Date;
  stories: Story[];
  repos: RepoWeek[];
}

export interface DigestDeps {
  config: CalibrationConfig;
  ledger?: StoryLedger;
  settings?: ObserveSettings;
  /** Run the cold-path catch-up first (default true). */
  reflect?: boolean;
  now?: Date;
}

export async function collectDigestInput(sinceDays: number, deps: DigestDeps): Promise<DigestInput> {
  const until = deps.now ?? new Date();
  const since = new Date(until.getTime() - sinceDays * 86_400_000);
  const dir = resolveArtifactsDir(deps.config.output_dir);
  const ledger = deps.ledger ?? StoryLedger.forArtifactsDir(dir);
  if (deps.reflect !== false) {
    try {
      await reflectPending({ config: deps.config, ledger, regenerate: true });
    } catch {
      /* a failed catch-up must not block the digest */
    }
  }
  const stories = loadAllStories(dir, ledger).filter((s) => s.status !== "discarded" && Date.parse(s.updated_at) >= since.getTime());

  const repos: RepoWeek[] = [];
  for (const repo of (deps.settings ?? loadObserveSettings()).enabled) {
    if (!isGitRepo(repo)) continue;
    const shas = git(repo, ["log", `--since=${since.toISOString()}`, `--until=${until.toISOString()}`, "--format=%H", "--no-merges"], { allowFail: true })
      .split(/\s+/)
      .filter(Boolean);
    if (shas.length === 0) continue;
    let facts: CodeFacts | undefined;
    for (const range of [`${shas[shas.length - 1]}~1..${shas[0]}`, shas[0]]) {
      try {
        facts = (await buildStructuralDigest({ root: repo, range, scanRepo: false })).facts;
        break;
      } catch {
        /* first commit of the repo: fall back to the narrower range */
      }
    }
    repos.push({ repo, commits: shas.length, facts });
  }
  return { since, until, stories, repos };
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** What the model sees: structured, bounded, numbers only from facts. */
export function digestRecords(input: DigestInput): string {
  return JSON.stringify(
    {
      window: `${day(input.since)} to ${day(input.until)}`,
      stories: input.stories.slice(0, 15).map((s) => ({
        title: s.title,
        status: s.status,
        one_liner: s.summary?.one_liner,
        tradeoffs: s.summary?.tradeoffs.slice(0, 3).map((t) => t.decision),
        dead_ends: s.summary?.dead_ends.slice(0, 3),
      })),
      repositories: input.repos.map((r) => ({
        repo: r.repo.split(/[\\/]/).pop(),
        commits: r.commits,
        files_changed: r.facts?.files_changed,
        entities: r.facts?.entities,
        classification: r.facts?.classification,
      })),
    },
    null,
    2
  );
}

/** Deterministic digest used when no model is available or it fails. */
export function fallbackDigest(input: DigestInput): string {
  const lines = ["## Stories", ""];
  if (input.stories.length === 0) lines.push("_No stories this week._");
  for (const s of input.stories) lines.push(`- **${s.title}**${s.status === "candidate" ? " (candidate)" : ""}${s.summary ? ` — ${s.summary.one_liner}` : ""}`);
  const deadEnds = input.stories.flatMap((s) => s.summary?.dead_ends ?? []);
  if (deadEnds.length) lines.push("", "## Dead ends and learnings", "", ...deadEnds.slice(0, 6).map((d) => `- ${d}`));
  if (input.repos.length) {
    lines.push("", "## By the numbers", "");
    for (const r of input.repos) {
      lines.push(`- ${r.repo.split(/[\\/]/).pop()}: ${r.commits} commit${r.commits === 1 ? "" : "s"}${r.facts ? `, ${r.facts.files_changed} files changed (${r.facts.classification})` : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

export async function composeDigest(input: DigestInput, config: CalibrationConfig, client?: LLMClient): Promise<string> {
  if (!client) return fallbackDigest(input);
  try {
    const { content: template } = loadPrompt("digest");
    const body = await callClaude(client, interpolate(template, { experience_level: config.experience_level, records: digestRecords(input) }), "Write the digest.");
    return body.trim() ? body.trim() + "\n" : fallbackDigest(input);
  } catch {
    return fallbackDigest(input);
  }
}

/** A synthetic SessionSummary so every existing connector can carry the digest. */
export function digestSession(input: DigestInput): SessionSummary {
  return {
    session_id: `digest-${day(input.until)}`,
    timestamp: input.until.toISOString(),
    source_tool: "skill-forge-digest",
    summary: {
      one_liner: `Weekly digest ${day(input.since)} to ${day(input.until)}: ${input.stories.length} stor${input.stories.length === 1 ? "y" : "ies"}`,
      problem_statement: "",
      approach: "",
      tradeoffs: [],
      dead_ends: [],
      technologies: [...new Set(input.stories.flatMap((s) => s.summary?.technologies ?? []))].slice(0, 12),
      patterns_used: [],
    },
  };
}

export interface DigestResult {
  output: TranslatorOutput;
  location: string;
  /** The text to print: the return_only delivery block, or a one-line confirmation. */
  printed: string;
  input: DigestInput;
}

export async function runWeeklyDigest(sinceDays: number, deps: DigestDeps & { client?: LLMClient; connector?: string }): Promise<DigestResult> {
  const config = { ...deps.config, ...(deps.connector ? { connector: deps.connector } : {}) };
  const input = await collectDigestInput(sinceDays, { ...deps, config });
  const content = await composeDigest(input, config, deps.client);
  const session = digestSession(input);
  const output: TranslatorOutput = { mode: "weekly-digest", session_id: session.session_id, timestamp: input.until.toISOString(), content };
  const location = await createConnector(config).write(output, session);
  const printed = config.connector === RETURN_ONLY ? formatReturnOnly(output, session, location) : `✓ weekly digest: ${location}`;
  return { output, location, printed, input };
}
