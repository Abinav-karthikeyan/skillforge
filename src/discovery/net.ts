import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { configDir } from "../config/paths.js";
import { writeFileAtomic } from "../util/fs.js";

/**
 * Network plumbing for discovery (plan_v3 §4.3). Discovery reads untrusted
 * content by definition, so the transport is locked down:
 *
 *   - an endpoint allowlist: grep.app and DeepWiki (public, no-auth, read-only
 *     MCP servers) and the GitHub REST API — nothing else, ever
 *   - timeouts and a byte cap on every response
 *   - a 7-day on-disk cache, so a story is never re-queried needlessly
 *   - a persisted token bucket for GitHub's 9 req/min code-search limit
 */
export const ALLOWED_HOSTS = new Set(["mcp.grep.app", "mcp.deepwiki.com", "api.github.com"]);

export const MAX_RESPONSE_BYTES = 512 * 1024;

export class EndpointNotAllowedError extends Error {}

export function assertAllowed(url: string): URL {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) {
    throw new EndpointNotAllowedError(`discovery may not contact ${u.protocol}//${u.hostname}`);
  }
  return u;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** GET JSON from an allowlisted host with a timeout and a byte cap. */
export async function getJson<T>(
  url: string,
  opts: { fetch?: FetchLike; headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<T> {
  assertAllowed(url);
  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await doFetch(url, {
      headers: { "user-agent": "skill-forge-discovery", accept: "application/json", ...opts.headers },
      signal: controller.signal,
    });
    const body = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
    if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
    return JSON.parse(body) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── cache ──────────────────────────────────────────────────────────────────

export class DiscoveryCache {
  constructor(
    readonly dir: string = join(configDir(), "cache", "discovery"),
    readonly ttlMs: number = 7 * 86_400_000
  ) {}

  private path(key: string): string {
    return join(this.dir, createHash("sha256").update(key).digest("hex").slice(0, 32) + ".json");
  }

  get<T>(key: string, now = Date.now()): T | undefined {
    const p = this.path(key);
    try {
      if (!existsSync(p) || now - statSync(p).mtimeMs > this.ttlMs) return undefined;
      return JSON.parse(readFileSync(p, "utf-8")) as T;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.path(key), JSON.stringify(value));
  }

  async wrap<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    this.set(key, value);
    return value;
  }
}

// ── rate limiting ──────────────────────────────────────────────────────────

/**
 * A token bucket persisted to disk, so separate CLI runs share GitHub's
 * per-minute budget. `take()` resolves when a token is available or rejects
 * past `maxWaitMs` — discovery degrades rather than stalls.
 */
export class TokenBucket {
  constructor(
    readonly name: string,
    readonly perMinute: number,
    readonly dir: string = join(configDir(), "cache", "ratelimit"),
    readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
  ) {}

  private file(): string {
    return join(this.dir, `${this.name}.json`);
  }

  private load(now: number): number[] {
    try {
      return (JSON.parse(readFileSync(this.file(), "utf-8")) as number[]).filter((t) => now - t < 60_000);
    } catch {
      return [];
    }
  }

  async take(maxWaitMs = 20_000, now: () => number = Date.now): Promise<void> {
    const start = now();
    for (;;) {
      const t = now();
      const recent = this.load(t);
      if (recent.length < this.perMinute) {
        mkdirSync(this.dir, { recursive: true });
        writeFileAtomic(this.file(), JSON.stringify([...recent, t]));
        return;
      }
      const wait = 60_000 - (t - Math.min(...recent)) + 50;
      if (t - start + wait > maxWaitMs) throw new Error(`rate limit: ${this.name} exhausted for this minute`);
      await this.sleep(wait);
    }
  }
}
