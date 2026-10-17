import { z } from "zod";
import { callClaude } from "../claude/client.js";
import { LLMClient } from "../claude/types.js";
import { looksInjected, sanitizeUntrusted } from "../discovery/sanitize.js";
import { safeJson } from "../observer/llm.js";
import { interpolate, loadPrompt } from "../translators/base.js";
import { canonicalRequirements, skillsIn } from "./taxonomy.js";

/**
 * Job-description parsing (v2 Bet 4 → plan_v3 Phase 3.5). An LLM extracts the
 * requirements; the taxonomy canonicalizes them and also provides a fully
 * deterministic fallback when no model is available or the reply is unusable.
 * JD text is pasted from anywhere, so it is sanitized and fenced as data.
 */
const FocusSchema = z.object({
  "system-design": z.number().min(0).max(1),
  behavioural: z.number().min(0).max(1),
  debugging: z.number().min(0).max(1),
  "technical-depth": z.number().min(0).max(1),
});

export const JobDescriptionSchema = z.object({
  role: z.string().default(""),
  seniority: z.enum(["junior", "mid", "senior", "staff", "principal", "unknown"]).default("unknown"),
  must_have: z.array(z.string()).default([]),
  nice_to_have: z.array(z.string()).default([]),
  responsibilities: z.array(z.string()).default([]),
  interview_focus: FocusSchema.optional(),
});

export type JobDescription = z.infer<typeof JobDescriptionSchema> & { source: "llm" | "keywords" };

const clean = (items: string[], max: number) =>
  [...new Set(items.flatMap((s) => canonicalRequirements(s.replace(/\s+/g, " ").trim())).filter((s) => s.length > 1 && s.length <= 60 && !looksInjected(s)))].slice(0, max);

/** Deterministic extraction: known skills, split into required vs preferred by section cues. */
export function parseJobDescriptionByKeywords(jd: string): JobDescription {
  const text = sanitizeUntrusted(jd, 20_000);
  const preferredAt = text.search(/\b(nice to have|preferred|bonus|plus|desirable)\b/i);
  const required = preferredAt === -1 ? text : text.slice(0, preferredAt);
  const preferred = preferredAt === -1 ? "" : text.slice(preferredAt);
  const must = skillsIn(required);
  const nice = skillsIn(preferred).filter((s) => !must.includes(s));
  const seniority = /\b(principal)\b/i.test(text) ? "principal" : /\bstaff\b/i.test(text) ? "staff" : /\b(senior|sr\.?)\b/i.test(text) ? "senior" : /\b(junior|jr\.?|entry)\b/i.test(text) ? "junior" : "unknown";
  const role = /^\s*(.{3,80}?)\s*$/m.exec(text)?.[1] ?? "";
  return { role, seniority, must_have: must, nice_to_have: nice, responsibilities: [], source: "keywords" };
}

export async function parseJobDescription(jd: string, client?: LLMClient): Promise<JobDescription> {
  const fallback = parseJobDescriptionByKeywords(jd);
  if (!client) return fallback;
  try {
    const { content: template } = loadPrompt("jd");
    const raw = await callClaude(client, interpolate(template, { jd: sanitizeUntrusted(jd, 20_000) }), "Extract the requirements.");
    const parsed = JobDescriptionSchema.safeParse(safeJson(raw));
    if (!parsed.success) return fallback;
    const d = parsed.data;
    // Keep anything the keyword pass found that the model missed.
    const must = clean([...d.must_have, ...fallback.must_have], 25);
    return {
      role: d.role.slice(0, 80) || fallback.role,
      seniority: d.seniority === "unknown" ? fallback.seniority : d.seniority,
      must_have: must,
      nice_to_have: clean([...d.nice_to_have, ...fallback.nice_to_have], 15).filter((s) => !must.includes(s)),
      responsibilities: clean(d.responsibilities, 6),
      interview_focus: d.interview_focus,
      source: "llm",
    };
  } catch {
    return fallback;
  }
}
