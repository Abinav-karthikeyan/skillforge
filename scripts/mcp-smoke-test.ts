#!/usr/bin/env npx tsx
/**
 * MCP smoke test — spawns the built MCP server (dist/mcp/server.js) over stdio using
 * the MCP client SDK (not the CLI directly) and drives it through: initialize,
 * tools/list, list_career_artifacts, and generate_career_artifact against the
 * sample fixture.
 *
 * This exercises the actual MCP protocol path, not just the underlying pipeline —
 * it's the closest thing to a real MCP host without one attached.
 *
 * Requires `npm run build` first (spawns dist/mcp/server.js directly — running two
 * nested tsx/esbuild loaders in parent + child hangs the stdio handshake).
 *
 * Usage:
 *   # Anthropic (default if ANTHROPIC_API_KEY is set)
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/mcp-smoke-test.ts
 *
 *   # Ollama (no key needed — must have `ollama serve` running with the model pulled)
 *   npx tsx scripts/mcp-smoke-test.ts --provider ollama --model qwen2.5
 *
 *   # OpenAI / any OpenAI-compatible endpoint
 *   OPENAI_API_KEY=sk-... npx tsx scripts/mcp-smoke-test.ts --provider openai --model gpt-4o-mini
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, mkdtempSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const provider = flag("--provider");
const model = flag("--model");
const baseUrl = flag("--base-url");

// Isolated cwd so this run's config doesn't depend on (or pollute) the repo root's config.
const smokeCwd = mkdtempSync(join(tmpdir(), "career-mode-mcp-smoke-"));
const outputDir = join(smokeCwd, "artifacts");

if (provider) {
  const configLines = [
    "experience_level: senior",
    "tone: balanced",
    `provider: ${provider}`,
    model ? `model: ${model}` : "",
    baseUrl ? `base_url: ${baseUrl}` : "",
  ].filter(Boolean);
  writeFileSync(join(smokeCwd, "career-mode.config.yaml"), configLines.join("\n") + "\n", "utf-8");
}

async function main() {
  // Spawn the built server directly with plain `node` — this test script itself
  // runs under tsx, and nesting a second tsx/esbuild loader inside a spawned child
  // hangs the MCP initialize handshake. Run `npm run build` before this script.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(PROJECT_ROOT, "dist/mcp/server.js")],
    cwd: smokeCwd,
    env: { ...process.env } as Record<string, string>,
  });

  const client = new Client({ name: "career-mode-smoke-test", version: "0.0.1" });

  // Cold start in this dev environment (OneDrive-synced node_modules) can take well over
  // the SDK's default 60s request timeout just to resolve imports — give it real headroom.
  const COLD_START_TIMEOUT_MS = 120_000;

  console.log("→ connecting (spawns dist/mcp/server.js over stdio)...");
  await client.connect(transport, { timeout: COLD_START_TIMEOUT_MS });
  console.log("✓ initialize handshake succeeded");

  const tools = await client.listTools(undefined, { timeout: COLD_START_TIMEOUT_MS });
  const gotNames = tools.tools.map((t) => t.name).sort();
  const expectedNames = ["generate_career_artifact", "list_career_artifacts"].sort();
  console.log(`✓ tools/list returned: ${gotNames.join(", ")}`);
  if (JSON.stringify(gotNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`Tool list mismatch. Expected ${expectedNames}, got ${gotNames}`);
  }

  console.log("\n→ list_career_artifacts (no LLM call)...");
  const listResult = await client.callTool(
    { name: "list_career_artifacts", arguments: { output_dir: outputDir } },
    undefined,
    { timeout: COLD_START_TIMEOUT_MS }
  );
  console.log("✓ responded:", JSON.stringify(listResult.content).slice(0, 150));

  console.log("\n→ generate_career_artifact against tests/fixtures/sample-session.json (real LLM call)...");
  const fixture = JSON.parse(
    readFileSync(join(PROJECT_ROOT, "tests/fixtures/sample-session.json"), "utf-8")
  );

  // LLM inference (especially local Ollama on CPU) can be slow — separate, larger budget.
  const GENERATE_TIMEOUT_MS = 300_000;
  const genResult = await client.callTool(
    {
      name: "generate_career_artifact",
      arguments: { mode: "portfolio-bullet", session_summary: fixture, output_dir: outputDir },
    },
    undefined,
    { timeout: GENERATE_TIMEOUT_MS }
  );

  const isError = (genResult as { isError?: boolean }).isError;
  const text = JSON.stringify(genResult.content);
  if (isError) {
    throw new Error(`generate_career_artifact returned isError: ${text.slice(0, 500)}`);
  }
  console.log("✓ generate_career_artifact succeeded:");
  console.log(text.slice(0, 400));

  await client.close();
  console.log(`\n✓ smoke test passed. Artifacts (if any) are under: ${outputDir}`);
}

main().catch((err) => {
  console.error("\n✗ SMOKE TEST FAILED:", err);
  process.exit(1);
});
