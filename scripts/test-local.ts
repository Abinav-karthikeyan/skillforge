#!/usr/bin/env npx tsx
/**
 * Local smoke test — runs the full translate pipeline against a fixture session.
 * No git repo required. Writes output to ./test-output/ so you can inspect it.
 *
 * Usage:
 *   # Anthropic (default if ANTHROPIC_API_KEY is set)
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/test-local.ts
 *
 *   # OpenAI
 *   OPENAI_API_KEY=sk-... npx tsx scripts/test-local.ts --provider openai --model gpt-4o-mini
 *
 *   # Ollama (no key needed — must have `ollama serve` running)
 *   npx tsx scripts/test-local.ts --provider ollama --model llama3.2
 *
 *   # Any OpenAI-compatible endpoint (e.g. LM Studio, Groq, Together)
 *   npx tsx scripts/test-local.ts --provider openai-compatible --base-url http://localhost:1234/v1 --model mistral
 *
 *   # Run all three modes
 *   npx tsx scripts/test-local.ts --mode all
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "../src/claude/client.js";
import { SessionSummarySchema, TranslationMode } from "../src/types/session.js";
import { translatePortfolioBullet } from "../src/translators/portfolio-bullet.js";
import { translateInterviewQA } from "../src/translators/interview-qa.js";
import { translateTechnicalDeepDive } from "../src/translators/technical-deep-dive.js";
import { renderMarkdown } from "../src/output/renderer.js";
import type { ProviderName } from "../src/claude/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI args (minimal, no commander dep needed for a dev script) ──────────────
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const providerArg = (flag("--provider") ?? undefined) as ProviderName | undefined;
const modelArg = flag("--model");
const baseUrlArg = flag("--base-url");
const modeArg = (flag("--mode") ?? "portfolio-bullet") as TranslationMode | "all";
const fixtureArg = flag("--fixture") ?? join(__dirname, "../tests/fixtures/sample-session.json");

// ── Load fixture ──────────────────────────────────────────────────────────────
console.log(`\nLoading fixture: ${fixtureArg}`);
const raw = JSON.parse(readFileSync(fixtureArg, "utf-8"));
const session = SessionSummarySchema.parse(raw);
console.log(`  Session: "${session.summary.one_liner}"`);

// ── Create provider ───────────────────────────────────────────────────────────
console.log(`\nProvider: ${providerArg ?? "auto-detect from env"}`);
const client = createClient({
  provider: providerArg,
  model: modelArg ?? undefined,
  base_url: baseUrlArg ?? undefined,
});

const config = {
  experience_level: "senior" as const,
  tone: "balanced" as const,
};

// ── Run translations ──────────────────────────────────────────────────────────
const modes: TranslationMode[] =
  modeArg === "all"
    ? ["portfolio-bullet", "interview-qa", "technical-deep-dive"]
    : [modeArg as TranslationMode];

const outDir = join(__dirname, "../test-output");
mkdirSync(outDir, { recursive: true });

for (const mode of modes) {
  console.log(`\nRunning mode: ${mode} ...`);
  const start = Date.now();

  let output;
  if (mode === "portfolio-bullet") {
    output = await translatePortfolioBullet(client, session, config);
  } else if (mode === "interview-qa") {
    output = await translateInterviewQA(client, session, config);
  } else {
    output = await translateTechnicalDeepDive(client, session, config);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const markdown = renderMarkdown(output, session);
  const filename = `${mode}-test.md`;
  const filepath = join(outDir, filename);

  writeFileSync(filepath, markdown, "utf-8");

  console.log(`  Done in ${elapsed}s → ${filepath}`);
  console.log("─".repeat(60));
  console.log(output.content);
  console.log("─".repeat(60));
}

console.log(`\nAll output written to: ${outDir}`);
