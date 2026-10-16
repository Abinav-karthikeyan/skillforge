import { createHash } from "crypto";
import { z } from "zod";
import { createClient, ProviderConfig } from "../claude/client.js";
import { LLMClient } from "../claude/types.js";
import { budgetTier } from "../orchestrator/budgets.js";
import { createSubagentRuntime } from "../orchestrator/subagent/factory.js";
import { SubagentRuntime } from "../orchestrator/subagent/types.js";
import { createObserverClient, safeJson } from "../observer/llm.js";
import { loadObserveSettings, repoPolicy } from "../observer/settings.js";
import { interpolate, loadPrompt } from "../translators/base.js";
import { CalibrationConfig } from "../types/config.js";
import { Evidence } from "../types/evidence.js";
import { SessionSummary } from "../types/session.js";
import { DiscoveryCache } from "./net.js";
import { askDeepWiki, CodeHit, GitHubClient, httpMcpCaller, McpCaller, RepoInfo, searchGrepApp } from "./providers.js";
import { buildDiscoveryQueries } from "./queries.js";
import { quarantinedSummarize } from "./quarantine.js";
import { looksInjected } from "./sanitize.js";

/**
 * Discovery scouts (plan_v3 §4.2). Career value, not coding help: find how
 * mature open-source projects solve the problem a story solved, so the
 * engineer can answer "why didn't you do it the way Envoy does?", and
 * calibrate whether the approach is standard or unusual.
 *
 *   prior-art   deterministic retrieval (grep.app, GitHub, DeepWiki) → health
 *               ranking → quarantined summaries → Evidence pinned to repo@SHA
 *               with its license
 *   calibration a SubagentSpec on the `discovery` budget tier that sees only
 *               the quarantined summaries, never raw repository text
 *
 * Retrieval is not an LLM tool loop on purpose: a model that can choose what
 * to fetch is a model untrusted content can steer.
 */
export type DiscoveryMode = "off" | "host" | "direct";

export interface DiscoveryDeps {
  grep?: McpCaller | null;
  deepwiki?: McpCaller | null;
  github?: GitHubClient | null;
  /** The quarantined summarizer: plain chat, no tools. */
  summarizer: LLMClient;
  /** Runs the calibration scout (privileged; sees summaries only). */
  calibrator?: SubagentRuntime | null;
  now?: () => Date;
  maxRepos?: number;
  /** Cap on provider calls for one story. */
  maxCalls?: number;
  experienceLevel?: string;
}

export interface DiscoveryResult {
  evidence: Evidence[];
  skipped?: string;
  notes: string[];
}

const slug = (repo: string) => repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const PERMISSIVE = /^(MIT|Apache-2\.0|BSD-[23]-Clause|ISC|MPL-2\.0|Unlicense|0BSD|Zlib)$/;

/**
 * Health- and topic-weighted ranking. Topic first — a repo *about* the
 * problem (found by repository search, or naming it) beats a famous repo
 * that merely mentions it — then popularity (log), recency, and license.
 */
export function rankCandidate(
  info: RepoInfo | undefined,
  hits: number,
  now: Date,
  topic: { fromRepoSearch?: boolean; terms?: string[] } = {}
): number {
  if (info && (info.archived || info.fork)) return -Infinity;
  let score = Math.min(hits, 3);
  if (topic.fromRepoSearch) score += 3;
  if (info) {
    const text = `${info.repo} ${info.description ?? ""} ${info.topics.join(" ")}`.toLowerCase();
    const named = (topic.terms ?? []).filter((t) => t.length > 3 && text.includes(t.toLowerCase())).length;
    score += Math.min(named, 2) * 2;
    score += Math.log10(info.stars + 1);
    const age = info.pushed_at ? (now.getTime() - Date.parse(info.pushed_at)) / 86_400_000 : Infinity;
    score += age < 365 ? 2 : age < 730 ? 1 : 0;
    score += !info.license ? -10 : PERMISSIVE.test(info.license) ? 1 : 0; // no known license → never cited
  }
  return score;
}

export async function runPriorArtScout(session: SessionSummary, deps: DiscoveryDeps): Promise<{ evidence: Evidence[]; notes: string[] }> {
  const notes: string[] = [];
  const now = (deps.now ?? (() => new Date()))();
  const maxRepos = deps.maxRepos ?? 4;
  let calls = 0;
  const maxCalls = deps.maxCalls ?? 24;
  const budgeted = async <T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> => {
    if (calls >= maxCalls) return fallback;
    calls++;
    try {
      return await fn();
    } catch (err) {
      notes.push(`${label}: ${(err as Error).message.split("\n")[0]}`);
      return fallback;
    }
  };

  const q = buildDiscoveryQueries(session);
  const candidates = new Map<string, { info?: RepoInfo; hits: CodeHit[]; fromRepoSearch?: boolean }>();
  const entry = (repo: string) => {
    const key = repo.toLowerCase();
    let c = candidates.get(key);
    if (!c) candidates.set(key, (c = { hits: [] }));
    return c;
  };

  if (deps.github && q.repoQuery.replace(/stars:.*$/, "").trim()) {
    for (const info of await budgeted(() => deps.github!.searchRepos(q.repoQuery), [], "github search")) {
      const e = entry(info.repo);
      e.info = info;
      e.fromRepoSearch = true;
    }
  }
  if (deps.grep) {
    for (const query of q.codeQueries) {
      const hits = await budgeted(() => searchGrepApp(deps.grep!, query, { language: q.language ? [q.language] : undefined }), [], "grep.app");
      for (const h of hits) entry(h.repo).hits.push(h);
    }
  }

  // Fill in health data for code-search-only candidates.
  if (deps.github) {
    const needInfo = [...candidates.entries()].filter(([, c]) => !c.info).sort((a, b) => b[1].hits.length - a[1].hits.length).slice(0, 6);
    for (const [, c] of needInfo) {
      const repo = c.hits[0].repo;
      c.info = await budgeted(() => deps.github!.repoInfo(repo), undefined, `github repo ${repo}`);
    }
  }

  const ranked = [...candidates.values()]
    .map((c) => ({ ...c, license: c.info?.license ?? c.hits.find((h) => h.license)?.license, repo: c.info?.repo ?? c.hits[0]?.repo }))
    .filter((c) => c.repo && c.license)
    .map((c) => ({ ...c, score: rankCandidate(c.info, c.hits.length, now, { fromRepoSearch: c.fromRepoSearch, terms: q.terms }) }))
    .filter((c) => Number.isFinite(c.score))
    .sort((a, b) => b.score - a.score);

  const evidence: Evidence[] = [];
  for (const c of ranked.slice(0, maxRepos + 2)) {
    if (evidence.length >= maxRepos) break;
    const repo = c.repo!;
    const sha = deps.github
      ? await budgeted(() => deps.github!.resolveSha(repo, c.info?.default_branch ?? "HEAD"), undefined, `github sha ${repo}`)
      : undefined;
    if (!sha) {
      notes.push(`${repo}: skipped (could not pin a commit SHA)`);
      continue;
    }
    const answer = deps.deepwiki
      ? await budgeted(
          () => askDeepWiki(deps.deepwiki!, repo, `How does ${repo} implement ${q.problem}? Describe the core algorithm and data structures in a few sentences.`),
          "",
          `deepwiki ${repo}`
        )
      : "";
    const content = [answer, ...c.hits.slice(0, 3).map((h) => `${h.path}:\n${h.snippet}`)].filter(Boolean).join("\n\n");
    if (!content) continue;
    const summary = await quarantinedSummarize(deps.summarizer, { repo, problem: q.problem, content });
    if (!summary || summary.relevance < 0.3) {
      notes.push(`${repo}: no usable summary${summary ? ` (relevance ${summary.relevance})` : " (dropped by quarantine validation)"}`);
      continue;
    }
    const hit = c.hits[0];
    evidence.push({
      id: `pa-${slug(repo)}-${sha.slice(0, 7)}`,
      kind: "prior_art",
      source: {
        provider: [answer ? "deepwiki" : null, c.hits.length ? "grep.app" : null, "github"].filter(Boolean).join("+"),
        url: hit ? `https://github.com/${repo}/blob/${sha}/${hit.path}` : `https://github.com/${repo}/tree/${sha}`,
        repo,
        sha,
        ...(hit ? { path: hit.path } : {}),
        license: c.license,
        retrieved_at: now.toISOString(),
      },
      summary: `${repo}: ${summary.approach_summary}${summary.patterns.length ? ` (patterns: ${summary.patterns.join(", ")})` : ""}`,
      confidence: Math.round(summary.relevance * 100) / 100,
    });
  }
  return { evidence, notes };
}

const CalibrationSchema = z.object({
  verdict: z.enum(["standard", "known-variant", "unusual"]),
  canonical_patterns: z.array(z.string()).default([]),
  note: z.string(),
  cites: z.array(z.string()).default([]),
});

export async function runCalibrationScout(
  session: SessionSummary,
  priorArt: Evidence[],
  runtime: SubagentRuntime,
  experienceLevel = "senior",
  now: Date = new Date()
): Promise<Evidence | null> {
  if (priorArt.length === 0) return null;
  const s = session.summary;
  const { content: template } = loadPrompt("calibration");
  const tier = budgetTier("discovery");
  const system = interpolate(template, {
    experience_level: experienceLevel,
    solution: JSON.stringify({
      one_liner: s.one_liner,
      approach: s.approach,
      patterns_used: s.patterns_used,
      decisions: s.tradeoffs.map((t) => t.decision),
    }),
    prior_art: priorArt.map((e) => `[${e.id}] ${e.summary}`).join("\n"),
  });
  let raw: string;
  try {
    raw = (await runtime.run({ system_prompt: system, user_prompt: "Calibrate.", deadline_ms: tier.deadline_ms, max_output_tokens: tier.max_output_tokens })).text;
  } catch {
    return null;
  }
  const parsed = CalibrationSchema.safeParse(safeJson(raw));
  if (!parsed.success) return null;
  const note = parsed.data.note.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!note || looksInjected(note)) return null;
  const known = new Set(priorArt.map((e) => e.id));
  const cites = parsed.data.cites.filter((c) => known.has(c));
  const patterns = parsed.data.canonical_patterns.filter((p) => p.length <= 40 && !looksInjected(p)).slice(0, 5);
  const id = `cal-${createHash("sha1").update(session.session_id + s.one_liner).digest("hex").slice(0, 10)}`;
  return {
    id,
    kind: "calibration",
    source: { provider: "skill-forge:calibration", retrieved_at: now.toISOString() },
    summary: `${parsed.data.verdict}: ${note}${patterns.length ? ` (canonical names: ${patterns.join(", ")})` : ""}${cites.length ? ` [based on ${cites.join(", ")}]` : ""}`,
    confidence: cites.length ? 0.75 : 0.5,
  };
}

export interface RunDiscoveryOptions {
  mode?: DiscoveryMode;
  /** Override confidential detection (default: the observer allowlist for cwd). */
  confidential?: boolean;
  deps?: Partial<DiscoveryDeps>;
  /** Main (privileged) client for the calibration subagent. */
  client?: LLMClient;
}

/** Run discovery for a story per the configured mode. Never throws. */
export async function runDiscovery(session: SessionSummary, config: CalibrationConfig, opts: RunDiscoveryOptions = {}): Promise<DiscoveryResult> {
  const mode = opts.mode ?? config.discovery ?? "off";
  if (mode === "off") return { evidence: [], skipped: "discovery is off", notes: [] };
  if (mode === "host") return { evidence: [], skipped: "host mode: the host agent supplies prior-art evidence", notes: [] };

  const confidential = opts.confidential ?? repoPolicy(process.cwd(), loadObserveSettings()).confidential;
  if (confidential) return { evidence: [], skipped: "confidential repository: no external discovery queries", notes: [] };

  const cache = new DiscoveryCache();
  const owned: McpCaller[] = [];
  const own = (c: McpCaller) => (owned.push(c), c);
  const deps: DiscoveryDeps = {
    grep: opts.deps?.grep !== undefined ? opts.deps.grep : own(httpMcpCaller("https://mcp.grep.app")),
    deepwiki: opts.deps?.deepwiki !== undefined ? opts.deps.deepwiki : own(httpMcpCaller("https://mcp.deepwiki.com/mcp")),
    github: opts.deps?.github !== undefined ? opts.deps.github : new GitHubClient({ token: config.github_token ?? process.env.GITHUB_TOKEN, cache }),
    summarizer: opts.deps?.summarizer ?? createObserverClient(config, false),
    calibrator:
      opts.deps?.calibrator !== undefined
        ? opts.deps.calibrator
        : createSubagentRuntime(
            opts.client ?? createClient({ provider: config.provider, model: config.model, base_url: config.base_url, api_key: config.api_key } as ProviderConfig),
            config
          ),
    now: opts.deps?.now,
    maxRepos: opts.deps?.maxRepos,
    maxCalls: opts.deps?.maxCalls,
  };

  const tier = budgetTier("discovery");
  const deadline = new Promise<DiscoveryResult>((resolve) =>
    setTimeout(() => resolve({ evidence: [], skipped: `discovery deadline (${tier.deadline_ms / 1000}s) reached`, notes: [] }), tier.deadline_ms).unref()
  );
  const work = (async (): Promise<DiscoveryResult> => {
    try {
      const { evidence, notes } = await runPriorArtScout(session, deps);
      const calibration = deps.calibrator
        ? await runCalibrationScout(session, evidence, deps.calibrator, config.experience_level, (deps.now ?? (() => new Date()))())
        : null;
      return { evidence: calibration ? [...evidence, calibration] : evidence, notes };
    } catch (err) {
      return { evidence: [], skipped: `discovery failed: ${(err as Error).message}`, notes: [] };
    }
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    await Promise.all(owned.map((c) => c.close()));
  }
}
