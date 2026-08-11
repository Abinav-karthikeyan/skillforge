#!/usr/bin/env node
import "./config/preload-env.js"; // must be the first import — loads .env before anything else
import { Command } from "commander";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createClient, ProviderConfig } from "./claude/client.js";
import { loadCalibration } from "./config/calibration.js";
import { ingestSession } from "./ingestor/index.js";
import { translatePortfolioBullet } from "./translators/portfolio-bullet.js";
import { translateInterviewQA } from "./translators/interview-qa.js";
import { translateTechnicalDeepDive } from "./translators/technical-deep-dive.js";
import { createConnector } from "./output/connectors/factory.js";
import { GistConnector } from "./output/connectors/gist.js";
import { readLastArtifact } from "./output/last-artifact.js";
import { TranslationMode } from "./types/session.js";

const program = new Command();

program
  .name("career-mode")
  .description("Transform coding sessions into career artifacts")
  .version("0.1.0");

program
  .command("generate")
  .description("Generate career artifacts from the current session or git context")
  .option("-m, --mode <mode>", "Translation mode: interview-qa, portfolio-bullet, technical-deep-dive, all", "portfolio-bullet")
  .option("-j, --json <path>", "Path to pre-formed SessionSummary JSON (slash command path)")
  .option("-o, --output-dir <dir>", "Output directory (overrides config)")
  .option("-c, --connector <name>", "Connector: local | gist (overrides config)")
  .option("-p, --prompt-version <version>", "Prompt version to use (e.g. v2). Falls back to manifest active version.")
  .action(async (opts) => {
    try {
      const config = loadCalibration();
      const client = createClient({
        provider: config.provider,
        model: config.model,
        base_url: config.base_url,
        api_key: config.api_key,
      } as ProviderConfig);

      if (opts.outputDir) config.output_dir = opts.outputDir;
      if (opts.connector) config.connector = opts.connector;

      let rawJson: string | undefined;
      if (opts.json) {
        rawJson = readFileSync(opts.json, "utf-8");
      }

      const session = await ingestSession(client, rawJson);
      const connector = createConnector(config);

      const modes: TranslationMode[] =
        opts.mode === "all"
          ? ["interview-qa", "portfolio-bullet", "technical-deep-dive"]
          : [opts.mode as TranslationMode];

      for (const mode of modes) {
        let output;
        if (mode === "portfolio-bullet") {
          output = await translatePortfolioBullet(client, session, config, opts.promptVersion);
        } else if (mode === "interview-qa") {
          output = await translateInterviewQA(client, session, config, opts.promptVersion);
        } else {
          output = await translateTechnicalDeepDive(client, session, config, opts.promptVersion);
        }

        const filepath = await connector.write(output, session);
        console.log(`✓ ${mode}: ${filepath}`);
      }
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List generated artifacts")
  .option("-o, --output-dir <dir>", "Output directory (overrides config)")
  .action((opts) => {
    try {
      const config = loadCalibration();
      const dir = opts.outputDir ?? config.output_dir ?? "~/.career-mode/artifacts";
      const resolved = dir.startsWith("~") ? join(homedir(), dir.slice(2)) : dir;
      const indexPath = join(resolved, "index.yml");

      try {
        const content = readFileSync(indexPath, "utf-8");
        console.log(content);
      } catch {
        console.log(`No artifacts found at ${resolved}`);
        console.log("Run `career-mode generate` to create your first artifact.");
      }
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exit(1);
    }
  });

program
  .command("share")
  .description("Push the most recent artifact to GitHub Gist and print the shareable URL")
  .option("-o, --output-dir <dir>", "Artifacts directory (overrides config)")
  .option("--public", "Create a public gist (default is secret)")
  .action(async (opts) => {
    try {
      const config = loadCalibration();
      if (opts.outputDir) config.output_dir = opts.outputDir;

      const last = readLastArtifact(config.output_dir);
      const gist = new GistConnector({
        token: config.gist_token,
        isPublic: opts.public ?? config.gist_public,
      });
      const url = await gist.createGist(
        last.filename,
        last.markdown,
        `Career Mode — ${last.entry.mode} — ${last.entry.one_liner}`
      );
      console.log(`✓ Shared: ${url}`);
      console.log(`  Source: ${last.filepath}`);
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exit(1);
    }
  });

program.parse();
