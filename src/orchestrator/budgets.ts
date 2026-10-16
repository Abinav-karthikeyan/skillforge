/**
 * Named budget tiers for orchestrator-spawned subagent turns.
 *
 * v2 had two tiers keyed by focus effort, and `low` spends zero tool calls, so
 * any feature that silently inherited the default tier got a scout with no
 * tools (plan_v3 §0). v3 names every tier and makes callers pick one
 * explicitly: `budgetTier()` throws on an unknown name instead of falling back.
 *
 * Naive char-based token estimate (~4 chars/token). Kept in-house to avoid a
 * tokenizer dep; good enough for a soft cap. `max_session_chars` truncates the
 * session JSON handed to the subagent so a huge session cannot balloon the
 * call past its tier. `max_output_tokens` / `max_tool_calls` are enforced by
 * the native runtime and by the inline JSON-envelope loop.
 */
export interface BudgetTier {
  max_session_chars: number;
  deadline_ms: number;
  max_output_tokens: number;
  max_tool_calls: number;
  label: BudgetTierName;
}

export type BudgetTierName =
  | "low"        // focus scout, single shot — no tools
  | "medium"     // focus scout with a few corroborating repo reads
  | "evidence"   // code-fact gathering over the local repo (Pillar A tools)
  | "discovery"; // OSS prior-art / calibration scouts (Pillar C)

export const BUDGET_TIERS: Readonly<Record<BudgetTierName, BudgetTier>> = Object.freeze({
  low:       { max_session_chars: 6_000,  deadline_ms: 15_000, max_output_tokens:  800, max_tool_calls: 0,  label: "low" },
  medium:    { max_session_chars: 20_000, deadline_ms: 30_000, max_output_tokens: 2000, max_tool_calls: 3,  label: "medium" },
  evidence:  { max_session_chars: 24_000, deadline_ms: 45_000, max_output_tokens: 2500, max_tool_calls: 6,  label: "evidence" },
  discovery: { max_session_chars: 12_000, deadline_ms: 90_000, max_output_tokens: 2500, max_tool_calls: 10, label: "discovery" },
});

export function isBudgetTierName(name: string): name is BudgetTierName {
  return Object.prototype.hasOwnProperty.call(BUDGET_TIERS, name);
}

/** Resolve a tier by name. Unknown names throw — there is no implicit default. */
export function budgetTier(name: string): BudgetTier {
  if (!isBudgetTierName(name)) {
    throw new Error(
      `Unknown budget tier "${name}". Valid tiers: ${Object.keys(BUDGET_TIERS).join(", ")}`
    );
  }
  return BUDGET_TIERS[name];
}
