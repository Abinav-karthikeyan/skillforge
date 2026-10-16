import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { assertAllowed, DiscoveryCache, FetchLike, getJson, TokenBucket } from "./net.js";

/**
 * Discovery providers (plan_v3 §4.3 `CodeSearchProvider`). Direct mode talks
 * to exactly three public, read-only endpoints:
 *
 *   grep.app  MCP `searchGitHub {query, language?, repo?, path?, …}`  — code search over ~1M repos
 *   DeepWiki  MCP `ask_wiki_question {repoName, question}`             — "how does repo X do Y"
 *   GitHub    REST /repos, /commits, /search/repositories             — license, stars, pinned SHA
 *
 * Tool names and argument names were confirmed with a live `tools/list`
 * (2026-10); the MCP caller still resolves tools by schema at runtime, so a
 * rename degrades to "no results" instead of an error. Nothing here sees an
 * LLM — raw results go to the quarantined summarizer only.
 */

// ── MCP ────────────────────────────────────────────────────────────────────

export interface McpTool {
  name: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

export interface McpCaller {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/** A stateless-per-session MCP client over streamable HTTP, allowlisted. */
export function httpMcpCaller(url: string, timeoutMs = 30_000): McpCaller {
  assertAllowed(url);
  let client: Client | null = null;
  const connect = async () => {
    if (client) return client;
    const c = new Client({ name: "skill-forge-discovery", version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(url)));
    client = c;
    return c;
  };
  return {
    async listTools() {
      const c = await connect();
      return (await c.listTools(undefined, { timeout: timeoutMs })).tools as McpTool[];
    },
    async callTool(name, args) {
      const c = await connect();
      const r = await c.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
      const content = (r.content ?? []) as Array<{ type?: string; text?: string }>;
      return content.map((x) => (x.type === "text" ? x.text ?? "" : "")).join("\n");
    },
    async close() {
      await client?.close().catch(() => {});
      client = null;
    },
  };
}

/** Find the tool whose name matches and whose schema has the required argument names. */
export async function resolveTool(caller: McpCaller, namePattern: RegExp, mustHave: string[]): Promise<McpTool | null> {
  const tools = await caller.listTools();
  return (
    tools.find((t) => namePattern.test(t.name) && mustHave.every((k) => t.inputSchema?.properties?.[k] !== undefined)) ??
    null
  );
}

// ── grep.app ───────────────────────────────────────────────────────────────

export interface CodeHit {
  provider: "grep.app";
  repo: string;
  path: string;
  url: string;
  license?: string;
  /** Raw, untrusted snippet text. */
  snippet: string;
}

/**
 * Parse grep.app's text result: blocks of `Repository:`, `Path:`, `URL:`,
 * `License:`, then `Snippets:` lines.
 */
export function parseGrepAppResults(text: string): CodeHit[] {
  const hits: CodeHit[] = [];
  for (const block of text.split(/(?=^Repository:\s)/m)) {
    const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(block)?.[1].trim();
    const repo = field("Repository");
    const path = field("Path");
    const url = field("URL");
    if (!repo || !path || !url || !/^[\w.-]+\/[\w.-]+$/.test(repo)) continue;
    const license = field("License");
    const snippet = block.split(/^Snippets:\s*$/m)[1] ?? "";
    hits.push({ provider: "grep.app", repo, path, url, license: license && license !== "Unknown" ? license : undefined, snippet: snippet.trim() });
  }
  return hits;
}

export async function searchGrepApp(
  caller: McpCaller,
  query: string,
  opts: { language?: string[]; cache?: DiscoveryCache } = {}
): Promise<CodeHit[]> {
  const run = async () => {
    const tool = await resolveTool(caller, /search/i, ["query"]);
    if (!tool) return [];
    const args: Record<string, unknown> = { query };
    if (opts.language?.length && tool.inputSchema?.properties?.language) args.language = opts.language;
    return parseGrepAppResults(await caller.callTool(tool.name, args));
  };
  return opts.cache ? opts.cache.wrap(`grep.app:${query}:${(opts.language ?? []).join(",")}`, run) : run();
}

// ── DeepWiki ───────────────────────────────────────────────────────────────

/** Ask DeepWiki how a public repo approaches something. Returns raw, untrusted text. */
export async function askDeepWiki(caller: McpCaller, repo: string, question: string, cache?: DiscoveryCache): Promise<string> {
  const run = async () => {
    const tool = await resolveTool(caller, /ask.*question|question/i, ["repoName", "question"]);
    if (!tool) return "";
    return caller.callTool(tool.name, { repoName: repo, question });
  };
  return cache ? cache.wrap(`deepwiki:${repo}:${question}`, run) : run();
}

// ── GitHub REST ────────────────────────────────────────────────────────────

export interface RepoInfo {
  repo: string;
  description?: string;
  stars: number;
  /** SPDX id, or undefined when GitHub reports none / NOASSERTION. */
  license?: string;
  pushed_at?: string;
  default_branch: string;
  archived: boolean;
  fork: boolean;
  topics: string[];
}

export interface IssueInfo {
  repo: string;
  url: string;
  /** Untrusted text: sanitize before display. */
  title: string;
  labels: string[];
  updated_at: string;
  comments: number;
  assigned: boolean;
}

interface GhIssue {
  repository_url?: string;
  html_url?: string;
  title?: string;
  labels?: Array<string | { name?: string }>;
  updated_at?: string;
  comments?: number;
  assignee?: unknown;
  assignees?: unknown[];
  pull_request?: unknown;
}

interface GhRepo {
  full_name: string;
  description?: string | null;
  stargazers_count?: number;
  license?: { spdx_id?: string | null } | null;
  pushed_at?: string;
  default_branch?: string;
  archived?: boolean;
  fork?: boolean;
  topics?: string[];
}

const toRepoInfo = (r: GhRepo): RepoInfo => {
  const spdx = r.license?.spdx_id ?? undefined;
  return {
    repo: r.full_name,
    description: r.description ?? undefined,
    stars: r.stargazers_count ?? 0,
    license: spdx && spdx !== "NOASSERTION" ? spdx : undefined,
    pushed_at: r.pushed_at,
    default_branch: r.default_branch ?? "main",
    archived: Boolean(r.archived),
    fork: Boolean(r.fork),
    topics: r.topics ?? [],
  };
};

export class GitHubClient {
  private readonly search: TokenBucket;
  private readonly core: TokenBucket;

  constructor(
    private readonly opts: { token?: string; fetch?: FetchLike; cache?: DiscoveryCache; buckets?: { search: TokenBucket; core: TokenBucket } } = {}
  ) {
    // Authenticated search is 30/min (code search 9/min); unauthenticated core is 60/hour.
    this.search = opts.buckets?.search ?? new TokenBucket("github-search", opts.token ? 9 : 5);
    this.core = opts.buckets?.core ?? new TokenBucket("github-core", opts.token ? 60 : 10);
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
    };
  }

  private get<T>(path: string, bucket: TokenBucket): Promise<T> {
    const url = `https://api.github.com${path}`;
    const run = async () => {
      await bucket.take();
      return getJson<T>(url, { fetch: this.opts.fetch, headers: this.headers() });
    };
    return this.opts.cache ? this.opts.cache.wrap(`github:${path}`, run) : run();
  }

  async searchRepos(query: string, limit = 10): Promise<RepoInfo[]> {
    const r = await this.get<{ items?: GhRepo[] }>(
      `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${limit}`,
      this.search
    );
    return (r.items ?? []).map(toRepoInfo);
  }

  async searchIssues(query: string, limit = 20): Promise<IssueInfo[]> {
    const r = await this.get<{ items?: GhIssue[] }>(
      `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${limit}`,
      this.search
    );
    return (r.items ?? [])
      .filter((i) => !i.pull_request)
      .map((i) => ({
        repo: (i.repository_url ?? "").replace(/^https:\/\/api\.github\.com\/repos\//, ""),
        url: i.html_url ?? "",
        title: i.title ?? "",
        labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
        updated_at: i.updated_at ?? "",
        comments: i.comments ?? 0,
        assigned: Boolean(i.assignee) || (i.assignees?.length ?? 0) > 0,
      }))
      .filter((i) => /^[\w.-]+\/[\w.-]+$/.test(i.repo) && i.url.startsWith("https://github.com/"));
  }

  async repoInfo(repo: string): Promise<RepoInfo> {
    return toRepoInfo(await this.get<GhRepo>(`/repos/${repo}`, this.core));
  }

  /** The commit SHA a ref points at, so a citation is pinned, not a moving branch. */
  async resolveSha(repo: string, ref: string): Promise<string> {
    const r = await this.get<{ sha?: string }>(`/repos/${repo}/commits/${encodeURIComponent(ref)}`, this.core);
    if (!r.sha) throw new Error(`no sha for ${repo}@${ref}`);
    return r.sha;
  }
}
