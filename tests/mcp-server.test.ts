/**
 * MCP integration test — spawns the BUILT server (dist/mcp/server.js) over stdio
 * using the MCP client SDK and asserts the tool surface matches expectations.
 *
 * Requires `npm run build` first (the dist/ tree must exist). CI runs build
 * before tests; the suite skips locally if dist is missing.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_SERVER = join(__dirname, "../dist/mcp/server.js");
const hasDist = existsSync(DIST_SERVER);

const EXPECTED_TOOLS = [
  // Current names
  "generate_skill_forge_artifact",
  "list_skill_forge_artifacts",
  "notion_auth_status",
  "share_last_artifact",
  // v3 observer review inbox
  "list_story_candidates",
  "approve_story",
  "discard_story",
  // v3 discovery (host mode)
  "plan_prior_art_search",
  // v3 compounding
  "tailor_to_job",
  "weekly_digest",
  "find_contributions",
  // Deprecated aliases kept for one release (see src/config/paths.ts migration window)
  "generate_career_artifact",
  "list_career_artifacts",
].sort();

// Cold start (especially under a synced node_modules) can exceed Vitest's default 5s timeout.
const REQUEST_TIMEOUT = 120_000;

const cwd = hasDist ? mkdtempSync(join(tmpdir(), "skillforge-mcp-test-")) : "";
const transport = hasDist
  ? new StdioClientTransport({
      command: process.execPath,
      args: [DIST_SERVER],
      cwd,
      env: { ...process.env } as Record<string, string>,
    })
  : null;
const client = new Client({ name: "skill-forge-test", version: "0.0.1" });

describe.skipIf(!hasDist)("MCP server (dist/mcp/server.js)", () => {
  beforeAll(async () => {
    await client.connect(transport!, { timeout: REQUEST_TIMEOUT });
  }, REQUEST_TIMEOUT);

  afterAll(async () => {
    await client.close().catch(() => {});
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it(
    "exposes the full tool surface over tools/list",
    async () => {
      const tools = await client.listTools(undefined, { timeout: REQUEST_TIMEOUT });
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(EXPECTED_TOOLS);
    },
    REQUEST_TIMEOUT
  );

  it(
    "responds to list_skill_forge_artifacts without an LLM call",
    async () => {
      const result = await client.callTool(
        { name: "list_skill_forge_artifacts", arguments: { output_dir: "no-such-dir" } },
        undefined,
        { timeout: REQUEST_TIMEOUT }
      );
      const text = JSON.stringify(result.content);
      expect(text).toContain("No artifacts found");
    },
    REQUEST_TIMEOUT
  );

  it(
    "still responds to the deprecated list_career_artifacts alias",
    async () => {
      const result = await client.callTool(
        { name: "list_career_artifacts", arguments: { output_dir: "no-such-dir" } },
        undefined,
        { timeout: REQUEST_TIMEOUT }
      );
      const text = JSON.stringify(result.content);
      expect(text).toContain("No artifacts found");
    },
    REQUEST_TIMEOUT
  );
});
