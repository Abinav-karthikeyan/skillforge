#!/usr/bin/env npx tsx
/**
 * DeepSeek smoke test — verifies the openai-compatible provider path against a
 * real DeepSeek endpoint. Requires DEEPSEEK_API_KEY in .env (project root or
 * ~/.career-mode/.env) OR exported in the shell.
 *
 * Two modes:
 *
 *   # Offline (default): asserts config-loader wiring — .env is discovered,
 *   # ${DEEPSEEK_API_KEY} is resolved, provider config is shaped correctly.
 *   # No network calls. Runs in CI.
 *   npx tsx scripts/deepseek-smoke-test.ts
 *
 *   # Live: real DeepSeek chat/completions call. Uses ~1000 tokens (a few cents).
 *   npx tsx scripts/deepseek-smoke-test.ts --live
 */

import "../src/config/preload-env.js";
import { loadCalibration } from "../src/config/calibration.js";
import { createClient } from "../src/claude/client.js";
import { SessionSummarySchema } from "../src/types/session.js";
import { translatePortfolioBullet } from "../src/translators/portfolio-bullet.js";
import { writeFileSync, mkdtempSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes("--live");

const DEEPSEEK_CONFIG = [
  "provider: openai-compatible",
  "model: deepseek-chat",
  "base_url: https://api.deepseek.com/v1",
  "api_key: ${DEEPSEEK_API_KEY}",
  "experience_level: senior",
  "tone: balanced",
  "",
].join("\n");

async function runOffline() {
  console.log("→ offline mode: verifying config resolution and provider wiring\n");

  const smokeCwd = mkdtempSync(join(tmpdir(), "career-mode-deepseek-"));
  writeFileSync(join(smokeCwd, "career-mode.config.yaml"), DEEPSEEK_CONFIG, "utf-8");
  writeFileSync(join(smokeCwd, ".env"), "DEEPSEEK_API_KEY=sk-fake-test-key-12345\n", "utf-8");

  const savedCwd = process.cwd();
  const savedKey = process.env.DEEPSEEK_API_KEY;
  try {
    process.chdir(smokeCwd);
    // Re-load .env from the new cwd (preload-env already ran, so call directly).
    const { loadDotenvFiles } = await import("../src/config/env.js");
    delete process.env.DEEPSEEK_API_KEY; // ensure .env is the source
    loadDotenvFiles();

    if (process.env.DEEPSEEK_API_KEY !== "sk-fake-test-key-12345") {
      throw new Error(`.env not loaded — DEEPSEEK_API_KEY=${process.env.DEEPSEEK_API_KEY}`);
    }
    console.log("✓ .env file loaded from cwd, DEEPSEEK_API_KEY populated");

    const config = loadCalibration();
    if (config.api_key !== "sk-fake-test-key-12345") {
      throw new Error(`${"$"}{DEEPSEEK_API_KEY} not resolved — api_key=${config.api_key}`);
    }
    if (config.base_url !== "https://api.deepseek.com/v1") throw new Error("base_url wrong");
    if (config.model !== "deepseek-chat") throw new Error("model wrong");
    if (config.provider !== "openai-compatible") throw new Error("provider wrong");
    console.log("✓ config loaded, ${DEEPSEEK_API_KEY} indirection resolved");

    const client = createClient({
      provider: config.provider,
      model: config.model,
      base_url: config.base_url,
      api_key: config.api_key,
    });
    if (!client) throw new Error("createClient returned nothing");
    console.log("✓ OpenAI-compatible client constructed with DeepSeek base URL and key");

    console.log("\n→ verifying missing-env-var error path");
    delete process.env.DEEPSEEK_API_KEY;
    try {
      loadCalibration();
      throw new Error("Should have thrown on missing DEEPSEEK_API_KEY");
    } catch (err) {
      const msg = (err as Error).message;
      if (!msg.includes("DEEPSEEK_API_KEY") || !msg.includes(".env")) {
        throw new Error(`Unhelpful error message: ${msg}`);
      }
      console.log("✓ threw with helpful message:", msg.slice(0, 100) + "...");
    }
  } finally {
    process.chdir(savedCwd);
    if (savedKey) process.env.DEEPSEEK_API_KEY = savedKey;
  }

  console.log("\n✓ offline smoke test passed");
}

async function runLive() {
  console.log("→ live mode: hitting real api.deepseek.com/v1/chat/completions\n");
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("--live requires DEEPSEEK_API_KEY in .env or shell env");
  }

  const config = {
    provider: "openai-compatible" as const,
    model: "deepseek-chat",
    base_url: "https://api.deepseek.com/v1",
    api_key: process.env.DEEPSEEK_API_KEY,
    experience_level: "senior" as const,
    tone: "balanced" as const,
  };

  const client = createClient(config);
  const fixture = SessionSummarySchema.parse(
    JSON.parse(readFileSync(join(__dirname, "../tests/fixtures/sample-session.json"), "utf-8"))
  );

  console.log("→ generating portfolio-bullet via DeepSeek (should take ~5-15s)...");
  const start = Date.now();
  const output = await translatePortfolioBullet(client, fixture, config);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`✓ Response received in ${elapsed}s\n`);
  console.log("=".repeat(70));
  console.log(output.content);
  console.log("=".repeat(70));
  console.log("\n✓ live DeepSeek smoke test passed");
}

(live ? runLive() : runOffline()).catch((err) => {
  console.error("\n✗ SMOKE TEST FAILED:", err);
  process.exit(1);
});
