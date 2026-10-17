import { Story } from "../types/ledger.js";
import { Gap, storySkills } from "../tailor/match.js";
import { lookupSkill } from "../tailor/taxonomy.js";
import { GitHubClient, IssueInfo, RepoInfo } from "./providers.js";
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
    const perGap = opts.perGap ?? 3;
    const found = new Map<string, RepoInfo>();
    for (const query of studyQueries(gap.requirement)) {
      if (found.size >= perGap) break;
      try {
        for (const r of await github.searchRepos(`${query} stars:>1000 archived:false fork:false`, 10)) {
          if (!r.archived && !r.fork && r.license && !found.has(r.repo)) found.set(r.repo, r);
        }
      } catch {
        // A failed search leaves fewer study targets, never an error.
      }
    }
    const study = [...found.values()]
      .sort((a, b) => b.stars - a.stars)
      .slice(0, perGap)
      .map((r) => ({ repo: r.repo, url: `https://github.com/${r.repo}`, stars: r.stars, license: r.license, pushed_at: r.pushed_at }));
    out.push({ ...gap, study });
  }
  return out;
}

/**
 * Searches for one gap, most precise first. A multi-word skill is quoted
 * (unquoted, GitHub matches each word anywhere, so "AI safety" finds email
 * clients), then tried as topic slugs, which owners curate ("vector-database").
 */
export function studyQueries(requirement: string): string[] {
  const words = requirement.replace(/["()]/g, " ").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 2) return [`${requirement} in:name,description,topics`];
  const slug = words.join("-");
  const singular = slug.replace(/([^s])s$/, "$1");
  return [`"${words.join(" ")}" in:name,description,topics`, `topic:${slug}`, ...(singular !== slug ? [`topic:${singular}`] : [])];
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

/** A GitHub topic slug for a skill: "AI agents" → ai-agents, "Node.js" → nodejs, "C#" → csharp. */
export function topicSlug(skill: string): string {
  return skill
    .toLowerCase()
    .replace(/\+/g, "plus")
    .replace(/#/g, "sharp")
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Repository first, then issues. Searching issues directly returns whatever was
 * updated last, which is mostly tiny repositories, so the scout first finds
 * healthy repositories in the user's languages that have open beginner issues
 * (GitHub's `good-first-issues:>N` qualifier), library topics first, and then
 * takes at most two unassigned issues from each.
 */
export async function contributionScout(
  stories: Story[],
  github: GitHubClient,
  opts: { limit?: number; now?: Date; minStars?: number } = {}
): Promise<ContributionTarget[]> {
  const now = opts.now ?? new Date();
  const profile = skillProfile(stories);
  const languages = profile.languages.slice(0, 2).map((l) => l.skill);
  const libraries = profile.libraries.slice(0, 6).map((l) => l.skill);
  if (languages.length === 0) return [];
  const since = new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
  const minStars = opts.minStars ?? 200;
  const healthy = `pushed:>${since} archived:false fork:false`;
  const gh = (lang: string) => `language:"${GITHUB_LANGUAGE[lang] ?? lang}"`;

  // At most three repository searches and five issue searches: GitHub allows 10 unauthenticated searches a minute.
  const repoQueries = [
    ...libraries.slice(0, 2).map((lib) => ({ lang: languages[0], q: `topic:${topicSlug(lib)} ${gh(languages[0])} good-first-issues:>1 stars:>${minStars} ${healthy}` })),
    { lang: languages[0], q: `${gh(languages[0])} good-first-issues:>3 stars:>${minStars * 5} ${healthy}` },
  ];
  const repos = new Map<string, { info: RepoInfo; lang: string }>();
  for (const { lang, q } of repoQueries) {
    if (repos.size >= 5) break;
    try {
      for (const r of await github.searchRepos(q, 5)) {
        if (!r.archived && !r.fork && r.license && r.stars >= minStars && !repos.has(r.repo)) repos.set(r.repo, { info: r, lang });
      }
    } catch {
      /* rate limited — use what we have */
    }
  }

  const seen = new Set<string>();
  const targets: ContributionTarget[] = [];
  for (const { info: repo, lang } of [...repos.values()].slice(0, 5)) {
    let issues: IssueInfo[] = [];
    try {
      issues = await github.searchIssues(`repo:${repo.repo} is:issue state:open no:assignee label:"good first issue" updated:>${since}`, 5);
    } catch {
      continue;
    }
    let taken = 0;
    for (const issue of issues) {
      if (taken >= 2) break;
      if (issue.assigned || seen.has(issue.url)) continue;
      const ageDays = (now.getTime() - Date.parse(issue.updated_at)) / 86_400_000;
      if (!(ageDays <= 180)) continue; // stale
      seen.add(issue.url);
      taken++;
      const haystack = `${repo.repo} ${repo.description ?? ""} ${repo.topics.join(" ")} ${issue.title} ${issue.labels.join(" ")}`.toLowerCase();
      const matched = [lang, ...libraries.filter((l) => haystack.includes(l.toLowerCase()) || repo.topics.includes(topicSlug(l)))];
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
        repo_license: repo.license!,
        score: Math.round(score * 100) / 100,
      });
    }
  }
  return targets.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 10);
}
