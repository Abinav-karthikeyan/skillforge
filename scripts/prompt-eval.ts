#!/usr/bin/env npx tsx
/**
 * Prompt evaluation harness.
 *
 * Runs all fixture sessions through specified prompt versions and modes,
 * writing outputs to test-output/eval/<timestamp>/ for side-by-side review.
 *
 * Usage:
 *   npx tsx scripts/prompt-eval.ts
 *   npx tsx scripts/prompt-eval.ts --versions v1,v2
 *   npx tsx scripts/prompt-eval.ts --modes interview-qa,portfolio-bullet
 *   npx tsx scripts/prompt-eval.ts --fixtures debugging-memory-leak,greenfield-auth-service
 *   npx tsx scripts/prompt-eval.ts --versions v1,v2 --modes interview-qa
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

async function main() {
  const args = process.argv.slice(2);

  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : undefined;
  };

  // --- Parse CLI args ---
  const versionsArg = flag("versions");
  const modesArg = flag("modes");
  const fixturesArg = flag("fixtures");

  type Mode = "interview-qa" | "portfolio-bullet" | "technical-deep-dive";
  const ALL_MODES: Mode[] = ["interview-qa", "portfolio-bullet", "technical-deep-dive"];

  const modes: Mode[] = modesArg
    ? (modesArg.split(",").map((m) => m.trim()) as Mode[])
    : ALL_MODES;

  // --- Resolve fixtures ---
  const fixturesDir = join(process.cwd(), "tests", "fixtures");
  const allFixtures = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => basename(f, ".json"));

  const fixtures = fixturesArg
    ? fixturesArg.split(",").map((f) => f.trim())
    : allFixtures;

  // --- Resolve versions from manifest ---
  const { parse } = await import("yaml");
  const manifest = parse(
    readFileSync(join(process.cwd(), "src", "prompts", "manifest.yaml"), "utf-8")
  ) as Record<string, { active: string; versions: Record<string, unknown> }>;

  const resolveVersions = (mode: Mode): string[] => {
    if (versionsArg) return versionsArg.split(",").map((v) => v.trim());
    // Default: all versions declared in manifest for this mode
    const key = mode === "technical-deep-dive" ? "technical-deepdive" : mode;
    const entry = manifest[key];
    return entry ? Object.keys(entry.versions) : ["v1"];
  };

  // --- Load pipeline ---
  const { createClient } = await import("../src/claude/client.js");
  const { loadCalibration } = await import("../src/config/calibration.js");
  const { translateInterviewQA } = await import("../src/translators/interview-qa.js");
  const { translatePortfolioBullet } = await import("../src/translators/portfolio-bullet.js");
  const { translateTechnicalDeepDive } = await import("../src/translators/technical-deep-dive.js");
  const { SessionSummarySchema } = await import("../src/types/session.js");

  const config = loadCalibration();
  const client = createClient({
    provider: config.provider,
    model: config.model,
    base_url: config.base_url,
    api_key: config.api_key,
  } as any);

  const runTranslator = async (
    mode: Mode,
    session: any,
    version: string
  ): Promise<string> => {
    if (mode === "interview-qa")
      return (await translateInterviewQA(client, session, config, version)).content;
    if (mode === "portfolio-bullet")
      return (await translatePortfolioBullet(client, session, config, version)).content;
    return (await translateTechnicalDeepDive(client, session, config, version)).content;
  };

  // --- Output directory ---
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const evalDir = join(process.cwd(), "test-output", "eval", timestamp);
  mkdirSync(evalDir, { recursive: true });

  console.log(`\n🧪 skill-forge prompt eval — ${timestamp}`);
  console.log(`   Fixtures : ${fixtures.join(", ")}`);
  console.log(`   Modes    : ${modes.join(", ")}`);
  console.log(`   Output   : ${evalDir}\n`);

  // --- Run ---
  const summary: string[] = [`# Eval run — ${timestamp}\n`];

  for (const fixtureName of fixtures) {
    const fixturePath = join(fixturesDir, `${fixtureName}.json`);
    let session: any;
    try {
      session = SessionSummarySchema.parse(JSON.parse(readFileSync(fixturePath, "utf-8")));
    } catch (err) {
      console.error(`  ✗ [${fixtureName}] failed to parse fixture: ${(err as Error).message}`);
      continue;
    }

    const fixtureDir = join(evalDir, fixtureName);
    mkdirSync(fixtureDir, { recursive: true });

    console.log(`📄 ${fixtureName}`);
    summary.push(`## ${fixtureName}\n`);
    summary.push(`> ${session.summary.one_liner}\n`);

    for (const mode of modes) {
      const versions = resolveVersions(mode);

      for (const version of versions) {
        process.stdout.write(`   ${mode}@${version} … `);
        const start = Date.now();
        try {
          const content = await runTranslator(mode, session, version);
          const elapsed = Date.now() - start;

          const outFile = join(fixtureDir, `${mode}-${version}.md`);
          const header = [
            `---`,
            `fixture: ${fixtureName}`,
            `mode: ${mode}`,
            `version: ${version}`,
            `elapsed_ms: ${elapsed}`,
            `one_liner: ${session.summary.one_liner}`,
            `---`,
            "",
          ].join("\n");
          writeFileSync(outFile, header + content, "utf-8");

          console.log(`✓ (${elapsed}ms)`);
          summary.push(`- [${mode}@${version}](./${fixtureName}/${mode}-${version}.md) — ${elapsed}ms`);
        } catch (err) {
          const elapsed = Date.now() - start;
          console.log(`✗ ${(err as Error).message.slice(0, 80)}`);
          summary.push(`- ~~[${mode}@${version}]~~ — FAILED: ${(err as Error).message.slice(0, 120)}`);
        }
      }
    }
    summary.push("");
  }

  // --- Write index ---
  writeFileSync(join(evalDir, "README.md"), summary.join("\n"), "utf-8");
  console.log(`\n✅ Done. Open ${evalDir} to review outputs.`);
  console.log(`   Side-by-side diff tip:\n`);
  console.log(`   diff test-output/eval/${timestamp}/<fixture>/interview-qa-v1.md \\`);
  console.log(`        test-output/eval/${timestamp}/<fixture>/interview-qa-v2.md\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
