import { SessionSummary } from "../types/session.js";

/**
 * Deterministic metric-honesty check (plan_v3 §6). Every number an artifact
 * states must already appear in its ground truth — the session summary, its
 * evidence, and (from Pillar A on) its code facts. An LLM judge can't be
 * trusted to notice an invented "reduced latency by 40%", but a set lookup can,
 * and it gives the same answer on every run, so scores stay comparable.
 *
 * Derived numbers (a percentage computed from two grounded values) are
 * reported as unsupported on purpose: the rule is "numbers only from facts".
 */
export interface MetricHonestyReport {
  /** 1–5; 5 means every stated number is grounded (or none were stated). */
  score: number;
  /** Distinct numeric claims found in the artifact, as written. */
  numbers_found: string[];
  /** The subset not present in the ground truth. */
  unsupported: string[];
}

// A number not glued to a preceding identifier character: excludes "RS256",
// "v2", "p99", "HTTP/2", "#123", "S3", "4.6" inside "4.6.1" chains.
const NUMBER_RE = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;

function stripNonClaims(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // fenced code is configuration, not a claim
    .replace(/`[^`\n]*`/g, " ") //       so is inline code
    .replace(/^\s*\d+[.)]\s+/gm, " ") // ordered-list markers
    .replace(/\b(?:19|20)\d{2}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g, " "); // ISO dates
}

function isGlued(text: string, index: number): boolean {
  const prev = text[index - 1];
  if (prev === undefined) return false;
  if (/[A-Za-z_/\\#.]/.test(prev)) return true;
  // "claude-sonnet-4-6" style identifiers: a hyphen preceded by an alphanumeric.
  if (prev === "-" && /[A-Za-z0-9]/.test(text[index - 2] ?? "")) return true;
  return false;
}

/** Normalize "1,200" / "15.0" / "15" to one comparable key. */
function numericKey(raw: string): string {
  return String(Number(raw.replace(/,/g, "")));
}

/** Extract numeric claims from free text (markdown artifact or summary prose). */
export function extractNumbers(text: string): string[] {
  const cleaned = stripNonClaims(text);
  const out: string[] = [];
  for (const match of cleaned.matchAll(NUMBER_RE)) {
    const index = match.index ?? 0;
    if (isGlued(cleaned, index)) continue;
    // A trailing ".<digit>" chain means a version string like "1.2.3".
    if (/^\.\d/.test(cleaned.slice(index + match[0].length))) continue;
    const value = Number(match[0].replace(/,/g, ""));
    // 0 and 1 read as words ("one service", "zero downtime") far more often
    // than as metrics; counting them would make every artifact look dishonest.
    if (!Number.isFinite(value) || value === 0 || value === 1) continue;
    out.push(match[0]);
  }
  return out;
}

function collectGroundNumbers(value: unknown, into: Set<string>): void {
  if (typeof value === "number") {
    into.add(numericKey(String(value)));
  } else if (typeof value === "string") {
    // Ground truth is scanned permissively: no glue rule, so "15 KB" and "v2"
    // both contribute — being generous here only ever avoids false alarms.
    for (const m of value.matchAll(NUMBER_RE)) into.add(numericKey(m[0]));
  } else if (Array.isArray(value)) {
    for (const v of value) collectGroundNumbers(v, into);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectGroundNumbers(v, into);
  }
}

/** Every number the artifact may legitimately state for this session. */
export function groundNumbers(session: SessionSummary, extra: unknown[] = []): Set<string> {
  const ground = new Set<string>();
  collectGroundNumbers(session.summary, ground);
  for (const e of extra) collectGroundNumbers(e, ground);
  return ground;
}

function scoreFor(unsupportedCount: number): number {
  if (unsupportedCount === 0) return 5;
  if (unsupportedCount === 1) return 4;
  if (unsupportedCount === 2) return 3;
  if (unsupportedCount <= 4) return 2;
  return 1;
}

export function checkMetricHonesty(
  artifact: string,
  session: SessionSummary,
  extraGround: unknown[] = []
): MetricHonestyReport {
  const ground = groundNumbers(session, extraGround);
  const found = [...new Set(extractNumbers(artifact))];
  const unsupported = found.filter((n) => !ground.has(numericKey(n)));
  return { score: scoreFor(unsupported.length), numbers_found: found, unsupported };
}
