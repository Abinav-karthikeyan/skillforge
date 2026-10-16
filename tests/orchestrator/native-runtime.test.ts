import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import {
  LLMClient,
  NativeToolCapability,
  NativeToolLoopSpec,
} from "../../src/claude/types.js";
import { AnthropicProvider } from "../../src/claude/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../../src/claude/providers/openai-compatible.js";
import { createSubagentRuntime } from "../../src/orchestrator/subagent/factory.js";
import {
  NativeToolRuntime,
  toNativeTool,
  unwrapFinalEnvelope,
} from "../../src/orchestrator/subagent/native.js";
import { SUBAGENT_TIMEOUT_MESSAGE } from "../../src/orchestrator/subagent/types.js";
import { ToolDef } from "../../src/orchestrator/subagent/tools/types.js";
import { BUDGET_TIERS, budgetTier } from "../../src/orchestrator/budgets.js";

const echoTool: ToolDef = {
  name: "echo",
  description: "Echo the input text",
  input_schema: z.object({ text: z.string(), times: z.number().int().default(1) }) as z.ZodType<unknown>,
  handler: async (input) => {
    const { text, times } = input as { text: string; times: number };
    return text.repeat(times);
  },
};

describe("budget tiers", () => {
  it("keeps the v2 focus tiers byte-for-byte", () => {
    expect(BUDGET_TIERS.low).toEqual({ max_session_chars: 6_000, deadline_ms: 15_000, max_output_tokens: 800, max_tool_calls: 0, label: "low" });
    expect(BUDGET_TIERS.medium).toEqual({ max_session_chars: 20_000, deadline_ms: 30_000, max_output_tokens: 2000, max_tool_calls: 3, label: "medium" });
  });

  it("names tool-spending tiers for evidence and discovery", () => {
    expect(budgetTier("evidence").max_tool_calls).toBeGreaterThan(0);
    const discovery = budgetTier("discovery");
    expect(discovery.max_tool_calls).toBeGreaterThanOrEqual(6);
    expect(discovery.max_tool_calls).toBeLessThanOrEqual(10);
    expect(discovery.deadline_ms).toBeGreaterThanOrEqual(60_000);
    expect(discovery.deadline_ms).toBeLessThanOrEqual(90_000);
  });

  it("has no implicit default: unknown tiers throw", () => {
    expect(() => budgetTier("high")).toThrow(/Unknown budget tier "high"/);
    expect(() => budgetTier("toString")).toThrow();
  });
});

describe("toNativeTool / unwrapFinalEnvelope", () => {
  it("renders the Zod input schema as JSON Schema and validates on execute", async () => {
    const native = toNativeTool(echoTool);
    expect(native.json_schema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" }, times: { type: "integer", default: 1 } },
      required: ["text"],
    });
    expect(native.json_schema.$schema).toBeUndefined();
    await expect(native.execute({ text: "ab", times: 2 })).resolves.toBe("abab");
    await expect(native.execute({ times: 2 })).rejects.toThrow();
  });

  it("unwraps a final envelope and passes bare JSON through", () => {
    expect(unwrapFinalEnvelope('{"action":"final","result":{"a":1}}')).toBe('{"a":1}');
    expect(unwrapFinalEnvelope('```json\n{"action":"final","result":"done"}\n```')).toBe("done");
    expect(unwrapFinalEnvelope('{"a":1}')).toBe('{"a":1}');
    expect(unwrapFinalEnvelope("plain text")).toBe("plain text");
  });
});

function fakeCapability(
  protocol: "anthropic" | "openai",
  impl: (spec: NativeToolLoopSpec) => Promise<{ text: string; tool_calls: number }>
): NativeToolCapability {
  return { protocol, runToolLoop: impl };
}

describe("NativeToolRuntime", () => {
  const chatOnly: LLMClient = { chat: async () => "single-shot" };

  it("runs a single chat turn when no tools are granted", async () => {
    const runToolLoop = vi.fn();
    const runtime = new NativeToolRuntime(chatOnly, fakeCapability("anthropic", runToolLoop), "claude-sdk");
    const result = await runtime.run({ system_prompt: "s", user_prompt: "u", deadline_ms: 1000 });
    expect(result.text).toBe("single-shot");
    expect(runToolLoop).not.toHaveBeenCalled();
  });

  it("hands converted tools and the budget to the provider loop, and unwraps the result", async () => {
    let seen: NativeToolLoopSpec | undefined;
    const runtime = new NativeToolRuntime(
      chatOnly,
      fakeCapability("openai", async (spec) => {
        seen = spec;
        return { text: '{"action":"final","result":{"ok":true}}', tool_calls: 2 };
      }),
      "openai-agents"
    );
    const result = await runtime.run({
      system_prompt: "sys",
      user_prompt: "go",
      deadline_ms: 1000,
      max_tool_calls: 3,
      tools: [echoTool],
    });
    expect(result.text).toBe('{"ok":true}');
    expect(result.tool_calls).toBe(2);
    expect(seen?.max_tool_calls).toBe(3);
    expect(seen?.tools.map((t) => t.name)).toEqual(["echo"]);
    expect(seen?.system_prompt).toMatch(/^sys\n/);
    expect(seen?.system_prompt).toContain("native tool-calling interface");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts the provider loop and rejects with the timeout sentinel at the deadline", async () => {
    let signal: AbortSignal | undefined;
    const runtime = new NativeToolRuntime(
      chatOnly,
      fakeCapability("anthropic", (spec) => {
        signal = spec.signal;
        return new Promise(() => {}); // never resolves
      }),
      "claude-sdk"
    );
    await expect(
      runtime.run({ system_prompt: "s", user_prompt: "u", deadline_ms: 20, max_tool_calls: 2, tools: [echoTool] })
    ).rejects.toThrow(SUBAGENT_TIMEOUT_MESSAGE);
    expect(signal?.aborted).toBe(true);
  });
});

describe("createSubagentRuntime", () => {
  const anthropicClient: LLMClient = {
    chat: async () => "",
    nativeTools: fakeCapability("anthropic", async () => ({ text: "", tool_calls: 0 })),
  };
  const openaiClient: LLMClient = {
    chat: async () => "",
    nativeTools: fakeCapability("openai", async () => ({ text: "", tool_calls: 0 })),
  };
  const plainClient: LLMClient = { chat: async () => "" };

  it("keeps auto (and unset) on the inline floor", () => {
    expect(createSubagentRuntime(anthropicClient, { experience_level: "senior" }).name).toBe("inline");
    expect(createSubagentRuntime(anthropicClient, { experience_level: "senior", subagent_runtime: "auto" }).name).toBe("inline");
  });

  it("maps native / claude-sdk / openai-agents onto matching providers", () => {
    const cfg = (subagent_runtime: "native" | "claude-sdk" | "openai-agents") => ({ experience_level: "senior" as const, subagent_runtime });
    expect(createSubagentRuntime(anthropicClient, cfg("native")).name).toBe("claude-sdk");
    expect(createSubagentRuntime(openaiClient, cfg("native")).name).toBe("openai-agents");
    expect(createSubagentRuntime(anthropicClient, cfg("claude-sdk")).name).toBe("claude-sdk");
    expect(createSubagentRuntime(openaiClient, cfg("openai-agents")).name).toBe("openai-agents");
  });

  it("degrades to inline when the provider can't honor the selection", () => {
    const cfg = (subagent_runtime: "native" | "claude-sdk" | "openai-agents") => ({ experience_level: "senior" as const, subagent_runtime });
    expect(createSubagentRuntime(openaiClient, cfg("claude-sdk")).name).toBe("inline");
    expect(createSubagentRuntime(anthropicClient, cfg("openai-agents")).name).toBe("inline");
    expect(createSubagentRuntime(plainClient, cfg("native")).name).toBe("inline");
  });
});

// ── Provider loops against scripted SDK clients ─────────────────────────────

function anthropicMessage(
  content: Array<Record<string, unknown>>,
  stop_reason: string
): Anthropic.Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as Anthropic.Message;
}

describe("AnthropicProvider native tool loop", () => {
  it("executes tool_use blocks, returns tool_result, and finishes on end_turn", async () => {
    const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const replies = [
      anthropicMessage(
        [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "tu1", name: "echo", input: { text: "hi" } },
        ],
        "tool_use"
      ),
      anthropicMessage([{ type: "text", text: '{"done":true}' }], "end_turn"),
    ];
    const sdk = {
      messages: {
        create: vi.fn(async (body: Anthropic.MessageCreateParamsNonStreaming) => {
          bodies.push(structuredClone(body));
          return replies.shift()!;
        }),
      },
    };
    const provider = new AnthropicProvider(undefined, "claude-sonnet-5", sdk);
    const result = await provider.nativeTools.runToolLoop({
      system_prompt: "sys",
      user_prompt: "go",
      tools: [toNativeTool(echoTool)],
      max_tool_calls: 3,
    });

    expect(result).toEqual({ text: '{"done":true}', tool_calls: 1, tokens_used: { input: 20, output: 10 } });
    expect(bodies[0].tool_choice).toEqual({ type: "auto" });
    expect(bodies[0].tools?.[0]).toMatchObject({ name: "echo", input_schema: { type: "object" } });
    // Turn 2 echoes the full assistant content, then the tool_result.
    const msgs = bodies[1].messages;
    expect(msgs[1]).toMatchObject({ role: "assistant" });
    expect(msgs[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu1", content: "hi" }],
    });
  });

  it("answers over-budget parallel calls with errors and forces tool_choice none", async () => {
    const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const replies = [
      anthropicMessage(
        [
          { type: "tool_use", id: "a", name: "echo", input: { text: "1" } },
          { type: "tool_use", id: "b", name: "echo", input: { text: "2" } },
        ],
        "tool_use"
      ),
      anthropicMessage([{ type: "text", text: "final" }], "end_turn"),
    ];
    const sdk = {
      messages: {
        create: vi.fn(async (body: Anthropic.MessageCreateParamsNonStreaming) => {
          bodies.push(structuredClone(body));
          return replies.shift()!;
        }),
      },
    };
    const provider = new AnthropicProvider(undefined, "claude-sonnet-5", sdk);
    const result = await provider.nativeTools.runToolLoop({
      system_prompt: "s",
      user_prompt: "u",
      tools: [toNativeTool(echoTool)],
      max_tool_calls: 1,
    });

    expect(result.text).toBe("final");
    expect(result.tool_calls).toBe(1);
    expect(bodies[1].tool_choice).toEqual({ type: "none" });
    const lastUser = bodies[1].messages[2].content as unknown as Array<Record<string, unknown>>;
    expect(lastUser[0]).toMatchObject({ tool_use_id: "a", content: "1" });
    expect(lastUser[1]).toMatchObject({ tool_use_id: "b", is_error: true });
    expect(lastUser[2]).toMatchObject({ type: "text" });
  });

  it("drops temperature for current models and keeps it for older ones", async () => {
    const create = vi.fn(async () => anthropicMessage([{ type: "text", text: "ok" }], "end_turn"));
    await new AnthropicProvider(undefined, "claude-sonnet-5", { messages: { create } }).chat("s", "u", { temperature: 0 });
    await new AnthropicProvider(undefined, "claude-sonnet-4-6", { messages: { create } }).chat("s", "u", { temperature: 0 });
    const calls = create.mock.calls as unknown as Array<[Anthropic.MessageCreateParamsNonStreaming]>;
    expect(calls[0][0].temperature).toBeUndefined();
    expect(calls[1][0].temperature).toBe(0);
  });

  it("throws on a refusal instead of returning empty text", async () => {
    const create = vi.fn(async () => anthropicMessage([], "refusal"));
    await expect(
      new AnthropicProvider(undefined, "claude-sonnet-5", { messages: { create } }).chat("s", "u")
    ).rejects.toThrow(/refusal/);
  });
});

function openaiCompletion(message: Record<string, unknown>): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: "c",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null, ...message } }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  } as unknown as OpenAI.Chat.Completions.ChatCompletion;
}

describe("OpenAICompatibleProvider native tool loop", () => {
  it("runs function calls, tolerates bad arguments, and forces tool_choice none at budget", async () => {
    const bodies: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming[] = [];
    const replies = [
      openaiCompletion({
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "echo", arguments: '{"text":"yo"}' } },
          { id: "c2", type: "function", function: { name: "echo", arguments: "{not json" } },
        ],
      }),
      openaiCompletion({ content: "answer" }),
    ];
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming) => {
            bodies.push(structuredClone(body));
            return replies.shift()!;
          }),
        },
      },
    };
    const provider = new OpenAICompatibleProvider({ model: "deepseek-chat", client });
    const result = await provider.nativeTools.runToolLoop({
      system_prompt: "s",
      user_prompt: "u",
      tools: [toNativeTool(echoTool)],
      max_tool_calls: 2,
    });

    expect(result).toEqual({ text: "answer", tool_calls: 2, tokens_used: { input: 14, output: 6 } });
    expect(bodies[0].tool_choice).toBe("auto");
    expect(bodies[0].tools?.[0]).toMatchObject({ type: "function", function: { name: "echo" } });
    expect(bodies[1].tool_choice).toBe("none");
    const toolMsgs = bodies[1].messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toEqual([
      { role: "tool", tool_call_id: "c1", content: "yo" },
      { role: "tool", tool_call_id: "c2", content: expect.stringMatching(/^error:/) },
    ]);
  });

  it("passes temperature through on chat", async () => {
    const create = vi.fn(async () => openaiCompletion({ content: "ok" }));
    await new OpenAICompatibleProvider({ client: { chat: { completions: { create } } } }).chat("s", "u", { temperature: 0 });
    const calls = create.mock.calls as unknown as Array<[OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming]>;
    expect(calls[0][0].temperature).toBe(0);
  });
});
