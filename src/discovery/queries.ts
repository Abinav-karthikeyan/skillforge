import { SessionSummary } from "../types/session.js";

/**
 * Turn a story into discovery queries using its fingerprint (Pillar A) and
 * summary: what problem was solved, with which patterns, in which language.
 * Only these derived terms leave the machine — never code, file paths, or
 * the summary prose itself. Confidential repos never reach this function.
 */
export interface DiscoveryQueries {
  /** Short problem phrase used in questions. */
  problem: string;
  /** GitHub repository search query. */
  repoQuery: string;
  /** grep.app code queries (identifiers / pattern names). */
  codeQueries: string[];
  /** Primary language, for grep.app's language filter. */
  language?: string;
  /** The terms the queries were built from, for display. */
  terms: string[];
}

const LANGUAGES = ["TypeScript", "JavaScript", "Python", "Go", "Java", "Rust", "C#", "Kotlin", "Ruby", "PHP", "C++", "C", "Swift", "Scala"];

const GENERIC = new Set(["design", "pattern", "architecture", "approach", "implementation", "system", "service", "api", "code", "refactor", "testing", "tests"]);

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !GENERIC.has(w));

const camel = (phrase: string) =>
  phrase
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join("");

/** Words that make a pattern name generic ("Middleware pattern" → "middleware"). */
const PATTERN_SUFFIX = /\s+(pattern|algorithm|approach|design|architecture|strategy|technique)s?$/i;

/** Verbs, articles, and filler in a one-liner — everything that isn't the thing that was built. */
const PROSE = new Set([
  "built", "build", "added", "add", "implemented", "implement", "designed", "design", "created", "create", "wrote",
  "fixed", "fix", "refactored", "extracted", "migrated", "replaced", "improved", "reduced", "introduced", "debugged",
  "tracked", "down", "found", "chased", "diagnosed", "investigated", "resolved", "solved", "eliminated", "removed",
  "shipped", "led", "owned", "made", "moved", "rewrote", "optimized", "sped", "cut", "caused",
  "the", "and", "for", "with", "into", "from", "that", "this", "our", "their", "its", "using", "via", "across",
  "backed", "based", "driven", "new", "single", "multi", "platform", "production", "existing",
]);

/**
 * The topic: up to two content words from the one-liner, after dropping
 * verbs, filler, and technology names ("Built a Redis-backed rate limiter for
 * the Express API" → "rate limiter"). Derived terms only — never the sentence.
 */
function topicOf(oneLiner: string, techs: string[]): string[] {
  const tech = new Set(techs.flatMap((t) => t.toLowerCase().split(/[\s.-]+/)));
  return oneLiner
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !PROSE.has(w) && !tech.has(w) && !GENERIC.has(w))
    .slice(0, 2);
}

export function buildDiscoveryQueries(session: SessionSummary): DiscoveryQueries {
  const s = session.summary;
  const fp = s.code_facts?.fingerprint;
  const patterns = [...new Set([...(fp?.patterns ?? []), ...s.patterns_used].map((p) => p.trim()).filter(Boolean))];
  const techs = [...new Set([...(fp?.frameworks ?? []), ...s.technologies])].filter((t) => !LANGUAGES.includes(t));
  const language = fp?.languages.find((l) => LANGUAGES.includes(l)) ?? s.technologies.find((t) => LANGUAGES.includes(t));

  const domain = patterns.map((p) => p.replace(PATTERN_SUFFIX, "").toLowerCase()).filter((p) => p && !GENERIC.has(p));
  const topic = topicOf(s.one_liner, techs);
  const repoTerms = [...new Set([...topic, ...(domain[0] ? domain[0].split(/\s+/) : [])])].slice(0, 5);
  const repoQuery = `${repoTerms.join(" ")} stars:>200 archived:false fork:false`.trim();

  // Identifiers an implementation would plausibly declare: real symbols from
  // code facts first, then the topic in CamelCase ("rate limiter" → RateLimiter).
  const symbols = (fp?.key_symbols ?? [])
    .map((k) => k.split(".").pop() ?? k)
    .filter((k) => /^[A-Z][A-Za-z0-9]{4,}$/.test(k));
  const topicIdent = topic.length ? camel(topic.join(" ")) : "";
  const domainIdent = domain[0] ? camel(domain[0]) : "";
  const codeQueries = [...new Set([...symbols.slice(0, 1), topicIdent, domainIdent].filter((c) => c.length > 4))].slice(0, 2);

  const how = domain.filter((d) => d !== topic.join(" ")).slice(0, 2);
  const problem = [topic.join(" "), how.length ? `using ${how.join(" and ")}` : "", techs[0] ? `with ${techs[0]}` : ""]
    .filter(Boolean)
    .join(" ")
    .slice(0, 140);
  return { problem, repoQuery, codeQueries, language, terms: [...repoTerms, ...codeQueries] };
}
