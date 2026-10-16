import { Story } from "../types/ledger.js";
import { adjacentSkills, canonicalName, mentions, skillsIn } from "./taxonomy.js";
import { JobDescription } from "./jd.js";

/**
 * Match a job description against the story ledger. Deterministic: a story
 * covers a requirement when its own text (title, summary, technologies,
 * patterns, code facts) mentions the skill or an alias. Every match carries
 * the story it came from, so a tailored bullet can always be traced back.
 */
export interface StoryMatch {
  story: Story;
  must: string[];
  nice: string[];
  score: number;
}

export interface Coverage {
  requirement: string;
  required: boolean;
  stories: string[];
}

export interface Gap {
  requirement: string;
  /** Skills the user *does* show that are nearest to the missing one. */
  adjacent: Array<{ skill: string; stories: string[] }>;
}

/** All the text a story offers as evidence of skills. */
export function storyText(story: Story): string {
  const s = story.summary;
  const facts = story.code_facts ?? s?.code_facts;
  return [
    story.title,
    s?.one_liner,
    s?.problem_statement,
    s?.approach,
    ...(s?.technologies ?? []),
    ...(s?.patterns_used ?? []),
    // A rejected alternative is not demonstrated experience, so only the decision counts.
    ...(s?.tradeoffs ?? []).map((t) => t.decision),
    ...(facts?.fingerprint?.languages ?? []),
    ...(facts?.fingerprint?.frameworks ?? []),
    ...(facts?.fingerprint?.dependencies_added ?? []),
    ...(facts?.fingerprint?.patterns ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Skills a story demonstrates (taxonomy-known, canonical). */
export function storySkills(story: Story): string[] {
  const text = storyText(story);
  const declared = [...(story.summary?.technologies ?? []), ...(story.code_facts?.fingerprint?.languages ?? [])].map(canonicalName);
  return [...new Set([...skillsIn(text), ...declared])];
}

export function matchStories(jd: JobDescription, stories: Story[], now = new Date()): StoryMatch[] {
  return stories
    .filter((s) => s.status !== "discarded")
    .map((story) => {
      const text = storyText(story);
      const must = jd.must_have.filter((r) => mentions(text, r));
      const nice = jd.nice_to_have.filter((r) => mentions(text, r));
      const ageDays = (now.getTime() - Date.parse(story.updated_at)) / 86_400_000;
      const recency = Number.isFinite(ageDays) ? Math.max(0, 1 - ageDays / 365) : 0;
      const score = must.length * 2 + nice.length + recency + (story.status === "approved" ? 0.5 : 0);
      return { story, must, nice, score };
    })
    .filter((m) => m.must.length + m.nice.length > 0)
    .sort((a, b) => b.score - a.score);
}

export function coverageOf(jd: JobDescription, matches: StoryMatch[]): Coverage[] {
  const row = (requirement: string, required: boolean): Coverage => ({
    requirement,
    required,
    stories: matches.filter((m) => (required ? m.must : m.nice).includes(requirement)).map((m) => m.story.story_id),
  });
  return [...jd.must_have.map((r) => row(r, true)), ...jd.nice_to_have.map((r) => row(r, false))];
}

/** Required skills nothing covers, with the nearest skills the ledger does show. */
export function gapsOf(coverage: Coverage[], stories: Story[]): Gap[] {
  const skillIndex = new Map<string, string[]>();
  for (const story of stories.filter((s) => s.status !== "discarded")) {
    for (const skill of storySkills(story)) skillIndex.set(skill, [...(skillIndex.get(skill) ?? []), story.story_id]);
  }
  return coverage
    .filter((c) => c.required && c.stories.length === 0)
    .map((c) => ({
      requirement: c.requirement,
      adjacent: adjacentSkills(c.requirement)
        .filter((s) => skillIndex.has(s))
        .slice(0, 3)
        .map((skill) => ({ skill, stories: skillIndex.get(skill)! })),
    }));
}
