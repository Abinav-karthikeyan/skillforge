#!/usr/bin/env node
/**
 * P0.2 — packaged-binary smoke test.
 *
 * Proves the two published binaries resolve and run from a clean install in a
 * host env we don't control — the precondition for the whole SKILL.md thesis
 * (Bet 1). Runs three checks, all network-free and provider-free:
 *
 *   1. `skill-forge --help`            → binary resolves, commander boots
 *   2. `skill-forge list -o <empty>`   → runs a real command with no provider
 *   3. `skill-forge-mcp` tools/list    → MCP server boots and advertises tools
 *
 * Bin commands come from env so the same script serves both CI (global install:
 * `skill-forge` / `skill-forge-mcp` on PATH) and local dev (`node dist/index.js`
 * / `node dist/mcp/server.js`). Space-split is fine — no path here has spaces.
 *
 *   SF_BIN     (default "skill-forge")
 *   SF_MCP_BIN (default "skill-forge-mcp")
 *
 * Exit 0 = all green; non-zero + message on the first failure.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = (process.env.SF_BIN ?? "skill-forge").split(" ");
const MCP = (process.env.SF_MCP_BIN ?? "skill-forge-mcp").split(" ");

function fail(msg) {
  console.error(`✗ pack-smoke: ${msg}`);
  process.exit(1);
}

function runCli(args, label) {
  const [cmd, ...base] = CLI;
  const res = spawnSync(cmd, [...base, ...args], { encoding: "utf-8", shell: process.platform === "win32" });
  if (res.error) fail(`${label}: could not spawn "${CLI.join(" ")}" (${res.error.message})`);
  if (res.status !== 0) fail(`${label}: exit ${res.status}\n${res.stderr || res.stdout}`);
  return (res.stdout ?? "") + (res.stderr ?? "");
}

// ── 1. --help ──────────────────────────────────────────────────────────────
const help = runCli(["--help"], "skill-forge --help");
if (!/skill-forge/.test(help)) fail(`--help output did not mention "skill-forge":\n${help}`);
console.log("✓ skill-forge --help");

// ── 2. list against an empty dir (no provider, no network) ──────────────────
const emptyDir = mkdtempSync(join(tmpdir(), "sf-smoke-"));
const list = runCli(["list", "--output-dir", emptyDir], "skill-forge list");
if (!/No artifacts found/.test(list)) fail(`list did not report an empty artifacts dir:\n${list}`);
console.log("✓ skill-forge list (empty dir)");

// ── 3. MCP tools/list handshake ─────────────────────────────────────────────
const REQUIRED_TOOL = "generate_career_artifact";
const mcpTimeoutMs = 15_000;

const mcpResult = await new Promise((resolve) => {
  const [cmd, ...base] = MCP;
  const child = spawn(cmd, base, { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
  let buf = "";
  let done = false;
  const timer = setTimeout(() => finish(`MCP server did not return tools/list within ${mcpTimeoutMs}ms`), mcpTimeoutMs);

  function finish(err) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { child.kill(); } catch {}
    resolve(err);
  }

  child.on("error", (e) => finish(`could not spawn "${MCP.join(" ")}" (${e.message})`));
  child.stderr.on("data", () => {}); // MCP logs to stderr; ignore

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    // Newline-delimited JSON-RPC frames
    for (const line of buf.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      let msg;
      try { msg = JSON.parse(t); } catch { continue; }
      if (msg.id === 2 && msg.result?.tools) {
        const names = msg.result.tools.map((x) => x.name);
        finish(names.includes(REQUIRED_TOOL) ? null : `tools/list missing "${REQUIRED_TOOL}"; got: ${names.join(", ")}`);
      }
    }
  });

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "pack-smoke", version: "0.0.0" },
  }});
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
});

if (mcpResult) fail(`skill-forge-mcp: ${mcpResult}`);
console.log(`✓ skill-forge-mcp tools/list advertises ${REQUIRED_TOOL}`);

console.log("\n✓ pack-smoke: all checks passed");
