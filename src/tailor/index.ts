import { join } from "path";
import { z } from "zod";
import { callClaude } from "../claude/client.js";
import { LLMClient } from "../claude/types.js";
import { resolveArtifactsDir } from "../config/paths.js";
import { gapScout, GapWithStudy } from "../discovery/career.js";
import { GitHubClient } from "../discovery/providers.js";
import { looksInjected } from "../discovery/sanitize.js";
import { StoryLedger } from "../ledger/store.js";
import { loadAllStories } from "../ledger/migrate.js";
import { safeJson } from "../observer/llm.js";
import { generateArtifacts } from "../pipeline/generate.js";
import { interpolate, loadPrompt } from "../translators/base.js";
import { CalibrationConfig } from "../types/config.js";
import { projectStory, Story } from "../types/ledger.js";
import { TranslationMode } from "../types/session.js";
import { JobDescription, parseJobDescription } from "./jd.js";
import { Coverage, coverageOf, gapsOf, matchStories, StoryMatch } from "./match.js";

/**
 * JD tailoring (v2 Bet 4, paired with the gap scout in plan_v3 Phase 3.5):
 * paste a job description → which of *your* stories to lead with and why,
 * coverage of every requirement, and the gaps with the nearest evidence you
 * do have plus repositories to study. Optionally renders tailored artifacts
 * for the top stories, using the JD as the focus lens. Tailored artifacts go
 * to `<artifacts>/tailored/<role>/` so the base living artifacts stay intact.
 */
export interface TailorOptions {
  config: CalibrationConfig;
  ledger?: StoryLedger;
  /** For JD parsing, framing angles, and tailored artifacts. Optional: keyword-only without it. */
  client?: LLMClient;
  /** Study targets for gaps (GitHub search). Null to skip. */
  github?: GitHubClient | null;
  top?: number;
  /** Render tailored artifacts for the top stories in these modes. */
  generate?: TranslationMode[];
  now?: Date;
}

export interface TailoringResult {
  jd: JobDescription;
  matches: StoryMatch[];
  coverage: Coverage[];
  gaps: GapWithStudy[];
  angles: Record<string, string>;
  markdown: string;
  generated: string[];
  stories_considered: number;
}

const AnglesSchema = z.object({ angles: z.array(z.object({ story_id: z.string(), angle: z.string() })).default([]) });

async function framingAngles(client: LLMClient, jd: JobDescription, top: StoryMatch[], level: string): Promise<Record<string, string>> {
  if (top.length === 0) return {};
  const { content: template } = loadPrompt("tailor-angles");
  const system = interpolate(template, {
    experience_level: level,
    role: jd.role || "(unspecified role)",
    requirements: [...new Set(top.flatMap((m) => [...m.must, ...m.nice]))].join(", "),
    stories: top.map((m) => `${m.story.story_id}: ${m.story.title} — ${m.story.summary?.one_liner ?? ""}; covers ${[...m.must, ...m.nice].join(", ")}`).join("\n"),
  });
  try {
    const parsed = AnglesSchema.safeParse(safeJson(await callClaude(client, system, "Write the angles.")));
    if (!parsed.success) return {};
    const ids = new Set(top.map((m) => m.story.story_id));
    return Object.fromEntries(
      parsed.data.angles
        .filter((a) => ids.has(a.story_id) && !looksInjected(a.angle))
        .map((a) => [a.story_id, a.angle.replace(/\s+/g, " ").trim().slice(0, 220)])
    );
  } catch {
    return {};
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "job";

export function renderTailoringReport(r: Omit<TailoringResult, "markdown" | "generated">): string {
  const must = r.coverage.filter((c) => c.required);
  const nice = r.coverage.filter((c) => !c.required);
  const covered = (cs: Coverage[]) => cs.filter((c) => c.stories.length > 0).length;
  const lines = [
    `# Tailoring: ${r.jd.role || "target role"}${r.jd.seniority !== "unknown" ? ` (${r.jd.seniority})` : ""}`,
    "",
    `Must-have coverage: **${covered(must)}/${must.length}** · nice-to-have: ${covered(nice)}/${nice.length} · stories considered: ${r.stories_considered}` +
      (r.jd.source === "keywords" ? " · requirements extracted by keyword (no model)" : ""),
    "",
    "## Stories to lead with",
    "",
  ];
  if (r.matches.length === 0) lines.push("_No story in the ledger matches this posting yet._", "");
  r.matches.forEach((m, i) => {
    lines.push(`${i + 1}. **${m.story.title}** — covers ${[...m.must.map((s) => `**${s}**`), ...m.nice].join(", ")}`);
    if (r.angles[m.story.story_id]) lines.push(`   - Angle: ${r.angles[m.story.story_id]}`);
    lines.push(`   - \`${m.story.story_id}\` · ${m.story.status}${m.story.version > 1 ? ` · v${m.story.version}` : ""}`);
  });
  lines.push("", "## Gaps and how to close them", "");
  if (r.gaps.length === 0) lines.push("_Every must-have is covered by at least one story._");
  for (const g of r.gaps) {
    const near = g.adjacent.length ? `nearest evidence you have: ${g.adjacent.map((a) => `${a.skill} (${a.stories.length} stor${a.stories.length === 1 ? "y" : "ies"})`).join(", ")}` : "no adjacent evidence in the ledger yet";
    lines.push(`- **${g.requirement}** — ${near}.`);
    for (const s of g.study) lines.push(`  - Study: [${s.repo}](${s.url}) · ★${s.stars.toLocaleString("en-US")}${s.license ? ` · ${s.license}` : ""}`);
  }
  lines.push("", "## Coverage", "", "| requirement | must-have | stories |", "| --- | --- | --- |");
  for (const c of r.coverage) lines.push(`| ${c.requirement} | ${c.required ? "yes" : "no"} | ${c.stories.length ? c.stories.map((s) => `\`${s}\``).join(", ") : "—"} |`);
  return lines.join("\n") + "\n";
}

export async function tailorToJob(jdText: string, opts: TailorOptions): Promise<TailoringResult> {
  const config = opts.config;
  const dir = resolveArtifactsDir(config.output_dir);
  const ledger = opts.ledger ?? StoryLedger.forArtifactsDir(dir);
  const stories: Story[] = loadAllStories(dir, ledger);

  const jd = await parseJobDescription(jdText, opts.client);
  const matches = matchStories(jd, stories, opts.now).slice(0, opts.top ?? 5);
  const allMatches = matchStories(jd, stories, opts.now);
  const coverage = coverageOf(jd, allMatches);
  const gaps = await gapScout(gapsOf(coverage, stories), opts.github ?? null);
  const angles = opts.client ? await framingAngles(opts.client, jd, matches, config.experience_level) : {};

  const base = { jd, matches, coverage, gaps, angles, stories_considered: stories.length };
  const markdown = renderTailoringReport(base);

  const generated: string[] = [];
  if (opts.generate?.length && opts.client) {
    const tailoredConfig: CalibrationConfig = {
      ...config,
      output_dir: join(dir, "tailored", slug(jd.role)),
      focus: [...jd.must_have, ...jd.responsibilities.slice(0, 2)],
      custom_instructions: {
        ...(typeof config.custom_instructions === "object" ? config.custom_instructions : {}),
        global: [
          typeof config.custom_instructions === "string" ? config.custom_instructions : config.custom_instructions?.global,
          `Target role: ${jd.role || "the role in the job description"}${jd.seniority !== "unknown" ? ` (${jd.seniority})` : ""}. ` +
            `Use the posting's vocabulary where it truthfully applies (${jd.must_have.join(", ")}). Never claim a requirement the story doesn't show.`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    };
    for (const m of matches.filter((x) => x.story.summary)) {
      const { story_id: _base, ...session } = projectStory(m.story);
      const result = await generateArtifacts(opts.client, tailoredConfig, session, opts.generate);
      generated.push(...result.artifacts.map((a) => a.location));
    }
  }
  return { ...base, markdown, generated };
}
