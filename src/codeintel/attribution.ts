import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { z } from "zod";
import { configDir } from "../config/paths.js";

/**
 * Agent Trace (agent-trace.dev, spec 0.1.0, Jan 2026): records attributing
 * file line ranges to the conversations and contributors (human / ai / mixed
 * / unknown) behind them. The spec deliberately leaves storage to
 * implementers, so skill-forge imports records explicitly
 * (`skill-forge import agent-trace <paths…>`) into a user-global store keyed
 * by commit, and code facts gain an `attribution` block for commits that have
 * traces. That lets artifacts say "AI-assisted" honestly instead of implying
 * sole authorship.
 */
const ContributorSchema = z.object({
  type: z.enum(["human", "ai", "mixed", "unknown"]),
  model_id: z.string().optional(),
});

const RangeSchema = z.object({
  start_line: z.number().int().min(1),
  end_line: z.number().int().min(1),
  content_hash: z.string().optional(),
  contributor: ContributorSchema.optional(),
});

export const AgentTraceRecordSchema = z.object({
  version: z.string(),
  id: z.string(),
  timestamp: z.string(),
  vcs: z.object({ type: z.string(), revision: z.string() }).optional(),
  tool: z.object({ name: z.string(), version: z.string().optional() }).optional(),
  files: z.array(
    z.object({
      path: z.string(),
      conversations: z.array(
        z.object({
          url: z.string().optional(),
          contributor: ContributorSchema.optional(),
          ranges: z.array(RangeSchema),
          related: z.unknown().optional(),
        })
      ),
    })
  ),
  metadata: z.unknown().optional(),
});

export type AgentTraceRecord = z.infer<typeof AgentTraceRecordSchema>;

export interface Attribution {
  ai_lines: number;
  human_lines: number;
  mixed_lines: number;
  unknown_lines: number;
  tools: string[];
  models: string[];
  records: number;
}

export function agentTraceStorePath(): string {
  return join(configDir(), "agent-traces.jsonl");
}

function collectFiles(path: string, out: string[], depth = 0): void {
  if (depth > 6 || out.length > 5_000) return;
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) collectFiles(join(path, name), out, depth + 1);
  } else if (/\.(json|jsonl)$/i.test(path)) {
    out.push(path);
  }
}

/** Parse trace records from files or directories (.json single/array, .jsonl). Invalid records are reported, not fatal. */
export function readAgentTraces(paths: string[]): { records: AgentTraceRecord[]; invalid: number } {
  const files: string[] = [];
  for (const p of paths) collectFiles(p, files);
  const records: AgentTraceRecord[] = [];
  let invalid = 0;
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const candidates: unknown[] = [];
    if (file.endsWith(".jsonl")) {
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          candidates.push(JSON.parse(line));
        } catch {
          invalid++;
        }
      }
    } else {
      try {
        const parsed = JSON.parse(raw);
        candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {
        invalid++;
      }
    }
    for (const c of candidates) {
      const r = AgentTraceRecordSchema.safeParse(c);
      if (r.success) records.push(r.data);
      else invalid++;
    }
  }
  return { records, invalid };
}

export function storeAgentTraces(records: AgentTraceRecord[], path = agentTraceStorePath()): number {
  if (records.length === 0) return 0;
  const known = new Set(loadAgentTraces(path).map((r) => r.id));
  const fresh = records.filter((r) => !known.has(r.id));
  if (fresh.length) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  }
  return fresh.length;
}

export function loadAgentTraces(path = agentTraceStorePath()): AgentTraceRecord[] {
  if (!existsSync(path)) return [];
  const out: AgentTraceRecord[] = [];
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = AgentTraceRecordSchema.safeParse(JSON.parse(line));
      if (r.success) out.push(r.data);
    } catch {
      /* torn line */
    }
  }
  return out;
}

/**
 * Line attribution over the records for the given commits (prefix match on
 * the revision). A range's contributor overrides its conversation's.
 */
export function attributionFor(records: AgentTraceRecord[], shas: string[]): Attribution | undefined {
  const wanted = shas.map((s) => s.toLowerCase());
  const matching = records.filter((r) => {
    const rev = r.vcs?.revision?.toLowerCase();
    return rev !== undefined && wanted.some((s) => rev.startsWith(s.slice(0, 7)) || s.startsWith(rev.slice(0, 7)));
  });
  if (matching.length === 0) return undefined;
  const totals = { ai: 0, human: 0, mixed: 0, unknown: 0 };
  const tools = new Set<string>();
  const models = new Set<string>();
  for (const r of matching) {
    if (r.tool?.name) tools.add(r.tool.name);
    for (const f of r.files) {
      for (const conv of f.conversations) {
        for (const range of conv.ranges) {
          const who = range.contributor ?? conv.contributor ?? { type: "unknown" as const };
          totals[who.type] += Math.max(0, range.end_line - range.start_line + 1);
          if (who.model_id) models.add(who.model_id);
        }
      }
    }
  }
  return {
    ai_lines: totals.ai,
    human_lines: totals.human,
    mixed_lines: totals.mixed,
    unknown_lines: totals.unknown,
    tools: [...tools].sort(),
    models: [...models].sort(),
    records: matching.length,
  };
}
