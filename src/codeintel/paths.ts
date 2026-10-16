/**
 * Path classification shared by the scout tools and code intelligence.
 * Generated, vendored, and build output must never count toward a person's
 * metrics (plan_v3 §2.5), and tests/docs/config drive change classification.
 */
export const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".cache",
  "coverage", ".turbo", ".venv", "__pycache__",
  // v3: vendored and build output for the starter languages.
  "vendor", "third_party", "target", "obj", ".gradle", ".mypy_cache",
  ".pytest_cache", ".tox", ".ledger",
]);

const GENERATED_FILE = [
  /\.min\.(js|css)$/i,
  /\.pb(\.gw)?\.go$/,
  /_pb2(_grpc)?\.py$/,
  /[._]generated\.\w+$/i,
  /\.g\.cs$/,
  /\.Designer\.cs$/,
  /\.snap$/,
];

const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json", "bun.lockb",
  "Cargo.lock", "go.sum", "poetry.lock", "Pipfile.lock", "composer.lock", "Gemfile.lock",
  "packages.lock.json", "uv.lock",
]);

const segments = (path: string) => path.split(/[\\/]/);
const basename = (path: string) => segments(path).pop() ?? path;

/** Build output, dependency dirs, generated files — excluded from metrics. */
export function isIgnoredPath(path: string): boolean {
  if (segments(path).some((s) => IGNORED_DIRS.has(s))) return true;
  return GENERATED_FILE.some((re) => re.test(path));
}

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(basename(path));
}

export function isTestPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return (
    /(^|\/)(tests?|__tests__|spec|specs|testing)\//i.test(p) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p) ||
    /(^|\/)test_[^/]+\.py$/.test(p) ||
    /_test\.(go|py)$/.test(p) ||
    /(Tests?|Spec)\.(cs|java|kt)$/.test(p)
  );
}

export function isDocPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return /\.(md|mdx|rst|adoc|txt)$/i.test(p) || /(^|\/)docs?\//i.test(p) || /(^|\/)(LICENSE|CHANGELOG|NOTICE)(\.\w+)?$/i.test(p);
}

export function isConfigPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  const base = basename(p);
  return (
    isLockfile(p) ||
    /\.(json|ya?ml|toml|ini|cfg|conf|properties|xml|env|lock)$/i.test(base) ||
    /^(Dockerfile|Makefile|Procfile|\.gitignore|\.gitattributes|\.editorconfig|\.npmrc|\.nvmrc)$/i.test(base) ||
    /(^|\/)\.github\//.test(p) ||
    /\.config\.[cm]?[jt]s$/.test(base) ||
    /\.(csproj|sln|gradle|gradle\.kts)$/.test(base)
  );
}
