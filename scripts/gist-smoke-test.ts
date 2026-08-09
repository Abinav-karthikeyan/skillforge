#!/usr/bin/env npx tsx
/**
 * Gist connector smoke test — two modes:
 *
 *   # Offline (default): mocks the GitHub API. Verifies request shape without
 *   # hitting the network or needing a token. Runs in CI.
 *   npx tsx scripts/gist-smoke-test.ts
 *
 *   # Live: hits real api.github.com. Needs GITHUB_TOKEN with `gist` scope.
 *   # Creates one SECRET gist under your account and prints the URL. Delete it
 *   # afterwards from https://gist.github.com/.
 *   GITHUB_TOKEN=ghp_... npx tsx scripts/gist-smoke-test.ts --live
 */

import { GistConnector } from "../src/output/connectors/gist.js";
import { SessionSummarySchema } from "../src/types/session.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes("--live");

const fixture = SessionSummarySchema.parse(
  JSON.parse(readFileSync(join(__dirname, "../tests/fixtures/sample-session.json"), "utf-8"))
);
const fakeOutput = {
  mode: "portfolio-bullet" as const,
  session_id: fixture.session_id,
  timestamp: new Date().toISOString(),
  content: "- Test bullet from gist-smoke-test.ts\n- Second bullet",
};

async function runOffline() {
  console.log("→ offline mode: mocking fetch");

  const captured: { url?: string; init?: RequestInit } = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = String(url);
    captured.init = init;
    return new Response(
      JSON.stringify({ html_url: "https://gist.github.com/fake/abc123", id: "abc123" }),
      { status: 201, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const connector = new GistConnector({ token: "fake-token", isPublic: false });
    const url = await connector.write(fakeOutput, fixture);

    console.log("✓ write() returned:", url);
    if (url !== "https://gist.github.com/fake/abc123") throw new Error("Wrong URL returned");

    console.log("→ verifying request shape");
    if (captured.url !== "https://api.github.com/gists") {
      throw new Error(`Wrong URL: ${captured.url}`);
    }
    const headers = captured.init?.headers as Record<string, string>;
    if (headers["Authorization"] !== "Bearer fake-token") throw new Error("Missing Authorization header");
    if (headers["Accept"] !== "application/vnd.github+json") throw new Error("Missing Accept header");

    const body = JSON.parse(String(captured.init?.body));
    if (body.public !== false) throw new Error("Default should be secret gist (public: false)");
    const files = Object.keys(body.files);
    if (files.length !== 1) throw new Error(`Expected 1 file, got ${files.length}`);
    if (!files[0].endsWith(".md")) throw new Error(`Filename should end in .md, got ${files[0]}`);
    if (!body.files[files[0]].content.includes("Test bullet from gist-smoke-test.ts")) {
      throw new Error("Gist body missing rendered content");
    }
    if (!body.description.startsWith("Career Mode — portfolio-bullet")) {
      throw new Error(`Bad description: ${body.description}`);
    }
    console.log("✓ request shape correct");

    console.log("\n→ verifying missing token throws");
    delete process.env.GITHUB_TOKEN;
    try {
      new GistConnector({});
      throw new Error("Should have thrown on missing token");
    } catch (err) {
      if (!(err as Error).message.includes("GitHub token")) throw err;
      console.log("✓ threw:", (err as Error).message.split("\n")[0]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("\n✓ offline smoke test passed");
}

async function runLive() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("--live requires GITHUB_TOKEN env var");
  console.log("→ live mode: hitting real api.github.com (creates one SECRET gist)");
  const connector = new GistConnector({ token, isPublic: false });
  const url = await connector.write(fakeOutput, fixture);
  console.log("✓ Created gist:", url);
  console.log("  Delete it manually at https://gist.github.com/ if you don't want it kept.");
}

(live ? runLive() : runOffline()).catch((err) => {
  console.error("\n✗ SMOKE TEST FAILED:", err);
  process.exit(1);
});
