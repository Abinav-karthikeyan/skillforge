import { Story } from "../types/ledger.js";
import { Gap, storySkills } from "../tailor/match.js";
import { lookupSkill } from "../tailor/taxonomy.js";
import { GitHubClient, RepoInfo } from "./providers.js";
import { sanitizeUntrusted } from "./sanitize.js";

/**
 * The compounding scouts (plan_v3 §4.2, Phase 3.5). Both read only public
 * GitHub metadata and render only structured fields — repo names, stars,
 * licenses, labels, dates — plus sanitized issue titles. No repository prose
 * reaches a model, so neither needs the quarantine summarizer.
 *
 *   gap scout           a JD requirement the ledger doesn't show → 2–3 well-kept
 *                       repositories to study
 *   contribution scout  skill-matched open issues ("good first issue", "help
 *                       wanted"), health-ranked; a list for the user, never filed
 */

// ── gap scout ──────────────────────────────────────────────────────────────

export interface StudyTarget {
  repo: string;
  url: string;
  stars: number;
  license?: string;
  pushed_at?: string;
}

export interface GapWithStudy extends Gap {
  study: StudyTarget[];
}

export async function gapScout(
  gaps: Gap[],
  github: GitHubClient | null,
  opts: { maxGaps?: number; perGap?: number } = {}
): Promise<GapWithStudy[]> {
  const out: GapWithStudy[] = [];
  for (const [i, gap] of gaps.entries()) {
    if (!github || i >= (opts.maxGaps ?? 5)) {
      out.push({ ...gap, study: [] });
      continue;
    }
    let repos: RepoInfo[] = [];
    try {
      repos = await github.searchRepos(`${gap.requirement} in:name,description,topics stars:>1000 archived:false fork:false`, 10);
    } catch {
      repos = [];
    }
    const study = repos
      .filter((r) => !r.archived && !r.fork && r.license)
      .slice(0, opts.perGap ?? 3)
      .map((r) => ({ repo: r.repo, url: `https://github.com/${r.repo}`, stars: r.stars, license: r.license, pushed_at: r.pushed_at }));
    out.push({ ...gap, study });
  }
  return out;
}

// ── contribution scout ─────────────────────────────────────────────────────

export interface SkillProfile {
  languages: Array<{ skill: string; stories: number }>;
  libraries: Array<{ skill: string; stories: number }>;
}

/** What the ledger *demonstrates* — counted per story, not declared. */
export function skillProfile(stories: Story[]): SkillProfile {
  const counts = new Map<string, number>();
  for (const story of stories.filter((s) => s.status !== "discarded")) {
    for (const skill of storySkills(story)) counts.set(skill, (counts.get(skill) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([skill, n]) => ({ skill, stories: n }));
  return {
    languages: ranked.filter((r) => lookupSkill(r.skill)?.category === "language"),
    libraries: ranked.filter((r) => {
      const c = lookupSkill(r.skill)?.category;
      return c !== undefined && c !== "language";
    }),
  };
}

export interface ContributionTarget {
  repo: string;
  issue_url: string;
  title: string;
  labels: string[];
  updated_at: string;
  comments: number;
  matched_skills: string[];
  repo_stars: number;
  repo_license: string;
  score: number;
}

/** GitHub's `language:` qualifier names. */
const GITHUB_LANGUAGE: Record<string, string> = { "C#": "C#", "C++": "C++", TypeScript: "TypeScript", JavaScript: "JavaScript" };

export function displayTitle(raw: string): string {
  return sanitizeUntrusted(raw, 140).replace(/[[\]()<>`*_#|]/g, "").replace(/\s+/g, " ").trim();
}

export async function contributionScout(
  stories: Story[],
  github: GitHubClient,
  opts: { limit?: number; now?: Date } = {}
): Promise<ContributionTarget[]> {
  const now = opts.now ?? new Date();
  const profile = skillProfile(stories);
  const languages = profile.languages.slice(0, 2).map((l) => l.skill);
  const libraries = profile.libraries.slice(0, 6).map((l) => l.skill);
  if (languages.length === 0) return [];
  const since = new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);

  const issues = [];
  for (const lang of languages) {
    for (const label of ['"good first issue"', '"help wanted"']) {
      const q = `is:issue state:open no:assignee archived:false label:${label} language:"${GITHUB_LANGUAGE[lang] ?? lang}" updated:>${since}`;
      try {
        issues.push(...(await github.searchIssues(q, 20)).map((i) => ({ ...i, lang })));
      } catch {
        /* rate limited — use what we have */
      }
    }
  }

  // Health data for the most promising repositories.
  const repos = [...new Set(issues.filter((i) => !i.assigned).map((i) => i.repo))].slice(0, 8);
  const info = new Map<string, RepoInfo>();
  for (const repo of repos) {
    try {
      info.set(repo, await github.repoInfo(repo));
    } catch {
      /* skip */
    }
  }

  const seen = new Set<string>();
  const targets: ContributionTarget[] = [];
  for (const issue of issues) {
    const repo = info.get(issue.repo);
    if (!repo || repo.archived || !repo.license || issue.assigned || seen.has(issue.url)) continue;
    const ageDays = (now.getTime() - Date.parse(issue.updated_at)) / 86_400_000;
    if (!(ageDays <= 180)) continue; // stale
    seen.add(issue.url);
    const haystack = `${repo.repo} ${repo.description ?? ""} ${repo.topics.join(" ")} ${issue.title} ${issue.labels.join(" ")}`.toLowerCase();
    const matched = [issue.lang, ...libraries.filter((l) => haystack.includes(l.toLowerCase()))];
    const score =
      Math.log10(repo.stars + 1) +
      (ageDays < 30 ? 2 : ageDays < 90 ? 1 : 0) +
      (matched.length - 1) * 2 +
      (issue.labels.some((l) => /good first issue/i.test(l)) ? 1 : 0) -
      (issue.comments > 15 ? 2 : 0);
    targets.push({
      repo: repo.repo,
      issue_url: issue.url,
      title: displayTitle(issue.title),
      labels: issue.labels.map((l) => displayTitle(l)).slice(0, 5),
      updated_at: issue.updated_at,
      comments: issue.comments,
      matched_skills: [...new Set(matched)],
      repo_stars: repo.stars,
      repo_license: repo.license,
      score: Math.round(score * 100) / 100,
    });
  }
  return targets.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 10);
}
