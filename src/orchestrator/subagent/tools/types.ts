import { z } from "zod";

/**
 * ToolDef — a runtime-agnostic tool the scout can invoke. Kept minimal on
 * purpose: name, description, a Zod schema for input validation, and a
 * handler that returns a string (the model consumes text, not objects).
 *
 * SDK-backed runtimes register these with their native tool-use APIs;
 * InlineRuntime executes them via a JSON tool-call loop over plain chat.
 * Neither runtime changes the ToolDef shape.
 */
export interface ToolDef<I = unknown> {
  name: string;
  description: string;
  input_schema: z.ZodType<I>;
  handler: (input: I) => Promise<string>;
}

export interface ToolInvocation {
  tool: string;
  input: unknown;
}

export interface ToolInvocationResult {
  tool: string;
  ok: boolean;
  output: string;
  elapsed_ms: number;
}
