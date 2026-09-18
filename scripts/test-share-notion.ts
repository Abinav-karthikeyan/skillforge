#!/usr/bin/env npx tsx
/**
 * Targeted test: share_last_artifact → notion via MCP.
 * Uses the real artifacts dir so it finds existing .md files.
 * Requires `npm run build` first.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

const TIMEOUT = 120_000;

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(PROJECT_ROOT, "dist/mcp/server.js")],
    // Use project root so it picks up skill-forge.config.yaml + .env
    cwd: PROJECT_ROOT,
    env: { ...process.env } as Record<string, string>,
  });

  const client = new Client({ name: "share-notion-test", version: "0.0.1" });

  console.log("→ connecting...");
  await client.connect(transport, { timeout: TIMEOUT });
  console.log("✓ connected");

  console.log("\n→ share_last_artifact (destination: notion)...");
  const result = await client.callTool(
    { name: "share_last_artifact", arguments: { destination: "notion" } },
    undefined,
    { timeout: TIMEOUT }
  );

  const text = (result.content as Array<{ text: string }>).map((c) => c.text).join("\n");
  const isError = (result as { isError?: boolean }).isError;

  if (isError) {
    console.error("✗ share_last_artifact failed:");
    console.error(text);
    process.exit(1);
  }

  console.log("✓ share_last_artifact succeeded:");
  console.log(text);

  await client.close();
}

main().catch((err) => {
  console.error("✗ test failed:", err);
  process.exit(1);
});
