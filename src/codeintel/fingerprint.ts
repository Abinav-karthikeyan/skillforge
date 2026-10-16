import { EntityChange, Fingerprint } from "../types/code-facts.js";
import { ChangedFile, fileAt, ResolvedRange } from "./git.js";
import { languageLabel } from "./languages.js";

/**
 * A fingerprint of what was built: languages, frameworks, dependencies the
 * change introduced, its key symbols, and the design-pattern names those
 * symbols suggest. Feeds Pillar C discovery queries and observer heuristics.
 */

const FRAMEWORKS: Array<[RegExp, string]> = [
  [/^react$/, "React"], [/^next$/, "Next.js"], [/^vue$/, "Vue"], [/^svelte$/, "Svelte"],
  [/^@angular\/core$/, "Angular"], [/^express$/, "Express"], [/^fastify$/, "Fastify"],
  [/^@nestjs\/core$/, "NestJS"], [/^hono$/, "Hono"], [/^vitest$/, "Vitest"], [/^jest$/, "Jest"],
  [/^prisma$|^@prisma\/client$/, "Prisma"], [/^zod$/, "Zod"], [/^@modelcontextprotocol\/sdk$/, "MCP SDK"],
  [/^@anthropic-ai\/sdk$/, "Anthropic SDK"], [/^openai$/, "OpenAI SDK"], [/^commander$/, "Commander"],
  [/^django$/i, "Django"], [/^flask$/i, "Flask"], [/^fastapi$/i, "FastAPI"], [/^torch$/i, "PyTorch"],
  [/^tensorflow$/i, "TensorFlow"], [/^pandas$/i, "pandas"], [/^sqlalchemy$/i, "SQLAlchemy"],
  [/^pydantic$/i, "Pydantic"], [/^pytest$/i, "pytest"],
  [/github\.com\/gin-gonic\/gin/, "Gin"], [/github\.com\/labstack\/echo/, "Echo"],
  [/google\.golang\.org\/grpc/, "gRPC"], [/github\.com\/spf13\/cobra/, "Cobra"],
  [/^tokio$/, "Tokio"], [/^axum$/, "Axum"], [/^actix-web$/, "Actix Web"], [/^serde$/, "Serde"],
  [/^clap$/, "Clap"], [/spring-boot/, "Spring Boot"], [/^Microsoft\.AspNetCore/, "ASP.NET Core"],
  [/^Microsoft\.EntityFrameworkCore/, "EF Core"],
];

const PATTERNS: Array<[RegExp, string]> = [
  [/Factory$/, "Factory"], [/Adapter$/, "Adapter"], [/Registry$/, "Registry"],
  [/Middleware/, "Middleware"], [/(Observer|Listener|Subscriber)$/, "Observer"],
  [/Strategy$/, "Strategy"], [/Builder$/, "Builder"], [/Visitor$/, "Visitor"],
  [/(Repository|Repo)$/, "Repository"], [/Provider$/, "Provider"], [/Decorator$/, "Decorator"],
  [/(Cache|Memo)/, "Caching"], [/(Retry|Backoff)/, "Retry/backoff"], [/(RateLimit|Limiter|Throttle)/, "Rate limiting"],
  [/(Queue|Worker)/, "Work queue"], [/(Plugin)/, "Plugin"], [/(Runtime)$/, "Runtime abstraction"],
  [/(Pool)$/, "Pooling"], [/(Pipeline)/, "Pipeline"], [/(Ledger|Journal)/, "Append-only log"],
];

/** Dependency names declared in a manifest's text. Best-effort, per ecosystem. */
export function manifestDependencies(path: string, text: string | null): string[] {
  if (!text) return [];
  const base = path.split(/[\\/]/).pop() ?? path;
  try {
    if (base === "package.json") {
      const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
      return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    }
  } catch {
    return [];
  }
  if (/^requirements.*\.txt$/.test(base)) {
    return text.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim().split(/[<>=!~;\[ ]/)[0]).filter(Boolean);
  }
  if (base === "go.mod") {
    return [...text.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[^\s]+)\s+v[\d.]/gm)].map((m) => m[1]);
  }
  if (base === "Cargo.toml" || base === "pyproject.toml") {
    const out: string[] = [];
    let inDepsTable = false;
    let inDepsList = false;
    for (const line of text.split(/\r?\n/)) {
      const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (section) {
        inDepsTable = /(^|\.)(dependencies|dev-dependencies)$/.test(section[1]);
        inDepsList = false;
        continue;
      }
      // PEP 621 list: dependencies = ["fastapi>=0.1", …] (possibly multi-line)
      if (/^\s*dependencies\s*=\s*\[/.test(line)) inDepsList = true;
      if (inDepsList) {
        for (const dep of line.matchAll(/["']([A-Za-z0-9_.-]+)/g)) out.push(dep[1]);
        if (line.includes("]")) inDepsList = false;
        continue;
      }
      if (inDepsTable) {
        const m = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line);
        if (m && m[1] !== "python") out.push(m[1]);
      }
    }
    return out;
  }
  if (/\.csproj$/.test(base)) {
    return [...text.matchAll(/<PackageReference\s+Include="([^"]+)"/g)].map((m) => m[1]);
  }
  if (base === "pom.xml") {
    return [...text.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map((m) => m[1]);
  }
  if (/^build\.gradle(\.kts)?$/.test(base)) {
    return [...text.matchAll(/["']([\w.-]+):([\w.-]+):[^"']+["']/g)].map((m) => m[2]);
  }
  return [];
}

const MANIFEST = /(^|[\\/])(package\.json|requirements[^\\/]*\.txt|go\.mod|Cargo\.toml|pyproject\.toml|pom\.xml|build\.gradle(\.kts)?|[^\\/]+\.csproj)$/;

export function isManifest(path: string): boolean {
  return MANIFEST.test(path) && !/node_modules/.test(path);
}

export function buildFingerprint(input: {
  root: string;
  range: ResolvedRange;
  files: ChangedFile[];
  tracked: string[];
  changes: EntityChange[];
}): Fingerprint {
  // Languages: share of tracked files, top five.
  const langCounts = new Map<string, number>();
  for (const path of input.tracked) {
    const label = languageLabel(path);
    if (label) langCounts.set(label, (langCounts.get(label) ?? 0) + 1);
  }
  const languages = [...langCounts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l]) => l);

  // Frameworks: dependencies of every manifest at head; additions: head − base.
  const headDeps = new Set<string>();
  const added = new Set<string>();
  for (const path of input.tracked.filter(isManifest).slice(0, 20)) {
    const deps = manifestDependencies(path, fileAt(input.root, input.range.head, path));
    deps.forEach((d) => headDeps.add(d));
    if (input.files.some((f) => f.path === path)) {
      const before = new Set(manifestDependencies(path, fileAt(input.root, input.range.base, path)));
      deps.filter((d) => !before.has(d)).forEach((d) => added.add(d));
    }
  }
  const frameworks = new Set<string>();
  for (const dep of headDeps) {
    for (const [re, name] of FRAMEWORKS) if (re.test(dep)) frameworks.add(name);
  }

  const significant = input.changes
    .filter((c) => c.change !== "removed")
    .sort((a, b) => Number(!!b.exported) - Number(!!a.exported));
  const key_symbols = [...new Set(significant.map((c) => c.symbol))].slice(0, 8);

  const patterns = new Set<string>();
  for (const c of significant) {
    const leaf = c.symbol.split(".").pop() ?? c.symbol;
    for (const [re, name] of PATTERNS) if (re.test(leaf)) patterns.add(name);
  }

  return {
    languages,
    frameworks: [...frameworks].sort(),
    dependencies_added: [...added].sort(),
    key_symbols,
    patterns: [...patterns].sort(),
  };
}
