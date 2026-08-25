import { LLMClient } from "../../claude/types.js";
import { callClaude } from "../../claude/client.js";
import { ToolDef } from "./tools/types.js";
import { SUBAGENT_TIMEOUT_MESSAGE } from "./types.js";

/**
 * A minimal JSON-based tool loop that runs on top of any LLMClient.chat().
 * It is intentionally protocol-simple so InlineRuntime works uniformly
 * across Anthropic, OpenAI-compatible, and Ollama providers without
 * requiring native tool-use APIs.
 *
 * Protocol: each model turn must return one JSON object of shape either
 *   { "action": "call_tool", "tool": "<name>", "input": {...} }
 *   { "action": "final",     "result": <arbitrary JSON> }
 *
 * The loop executes tools up to `maxToolCalls`; when the budget is spent
 * it forces one last turn asking for `final`. When the wall-clock deadline
 * elapses, the loop rejects with `SUBAGENT_TIMEOUT_MESSAGE` so the caller
 * can classify it uniformly with single-shot timeouts.
 */

export interface ToolLoopSpec {
  system_prompt: string;
  user_prompt: string;
  tools: ToolDef[];
  max_tool_calls: number;
  deadline_ms: number;
}

export interface ToolLoopResult {
  /** The `result` field of the final `{action:"final"}` turn, stringified. */
  text: string;
  tool_calls: number;
}

interface TurnEnvelope {
  action?: "call_tool" | "final";
  tool?: string;
  input?: unknown;
  result?: unknown;
}

function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
}

function parseEnvelope(raw: string): TurnEnvelope | null {
  try {
    const obj = JSON.parse(stripFences(raw));
    if (obj && typeof obj === "object") return obj as TurnEnvelope;
  } catch { /* fall through */ }
  return null;
}

function toolsBlock(tools: ToolDef[]): string {
  const lines: string[] = ["Available tools:"];
  for (const t of tools) {
    // Zod schemas don't serialize cleanly — we render the description alone
    // and trust the schema for validation. Cheap, and works with any provider.
    lines.push(`- ${t.name}: ${t.description}`);
  }
  return lines.join("\n");
}

function protocolBlock(): string {
  return [
    "",
    "Tool-use protocol:",
    "  You reply with EXACTLY ONE JSON object per turn — no prose, no markdown fences.",
    "  To invoke a tool:",
    '    {"action":"call_tool","tool":"<name>","input":{ ... }}',
    "  To finish (return your structured result):",
    '    {"action":"final","result": { ... }}',
    "  Prefer to call tools before finalizing when the focus lens would benefit from repo evidence.",
    "  Call at most the tool-call budget stated in the user turn; on the last allowed turn you MUST emit `final`.",
  ].join("\n");
}

export async function runToolLoop(
  client: LLMClient,
  spec: ToolLoopSpec
): Promise<ToolLoopResult> {
  const toolMap = new Map(spec.tools.map((t) => [t.name, t]));
  const system = `${spec.system_prompt}\n\n${toolsBlock(spec.tools)}\n${protocolBlock()}`;
  const transcript: string[] = [
    spec.user_prompt,
    `Tool-call budget for this turn: ${spec.max_tool_calls}.`,
  ];

  const started = Date.now();
  let toolCalls = 0;

  const remaining = () => spec.deadline_ms - (Date.now() - started);
  const timeoutRace = <T>(p: Promise<T>): Promise<T> => {
    const left = remaining();
    if (left <= 0) return Promise.reject(new Error(SUBAGENT_TIMEOUT_MESSAGE));
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(SUBAGENT_TIMEOUT_MESSAGE)), left)
      ),
    ]);
  };

  // The loop runs at most maxToolCalls+1 turns: one final turn after the
  // tool budget is spent. The +1 also covers the common case where the
  // model returns `final` immediately without touching tools.
  for (let turn = 0; turn <= spec.max_tool_calls; turn++) {
    const isLastAllowedTurn = turn === spec.max_tool_calls;
    if (isLastAllowedTurn) {
      transcript.push("Budget exhausted — emit your `final` envelope now.");
    }
    const userTurn = transcript.join("\n\n");
    const raw = await timeoutRace(callClaude(client, system, userTurn));
    const env = parseEnvelope(raw);

    if (!env || !env.action) {
      // Model broke protocol. Nudge once, then treat any further protocol
      // break as a `final` fallback carrying the raw text — the caller's
      // JSON validator will then decide whether the payload is usable.
      transcript.push(`Assistant reply did not parse as protocol JSON:\n${raw}`);
      transcript.push("Reply again with a valid envelope.");
      continue;
    }

    if (env.action === "final") {
      const payload =
        typeof env.result === "string" ? env.result : JSON.stringify(env.result);
      return { text: payload, tool_calls: toolCalls };
    }

    if (env.action === "call_tool" && env.tool) {
      const tool = toolMap.get(env.tool);
      if (!tool) {
        transcript.push(`Assistant called unknown tool "${env.tool}". Available: ${[...toolMap.keys()].join(", ")}`);
        continue;
      }
      let output: string;
      try {
        const validated = tool.input_schema.parse(env.input);
        output = await timeoutRace(tool.handler(validated));
      } catch (err) {
        output = `error: ${(err as Error).message}`;
      }
      toolCalls++;
      transcript.push(
        `Assistant called tool "${env.tool}" with input ${JSON.stringify(env.input)}.`,
        `Tool result:\n${output}`
      );
      continue;
    }

    // Unknown action — treat as protocol break.
    transcript.push(`Unrecognized action "${env.action}". Reply with call_tool or final.`);
  }

  // If we exit the loop without seeing `final`, force one last turn.
  transcript.push("Emit your `final` envelope now — no more tool calls allowed.");
  const forced = await timeoutRace(
    callClaude(client, system, transcript.join("\n\n"))
  );
  const env = parseEnvelope(forced);
  const payload =
    env && env.action === "final"
      ? typeof env.result === "string" ? env.result : JSON.stringify(env.result)
      : forced;
  return { text: payload, tool_calls: toolCalls };
}
