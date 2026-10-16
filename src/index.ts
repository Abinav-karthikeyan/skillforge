#!/usr/bin/env node
import "./config/preload-env.js"; // must be the first import — loads .env before anything else
import { Command } from "commander";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { resolveArtifactsDir } from "./config/paths.js";
import { createClient, ProviderConfig } from "./claude/client.js";
import { loadCalibration } from "./config/calibration.js";
import { ingestSession } from "./ingestor/index.js";
import { listConnectors } from "./output/connectors/factory.js";
import { RETURN_ONLY, formatReturnOnly } from "./output/return-only.js";
import { GistConnector } from "./output/connectors/gist.js";
import { readLastArtifact } from "./output/last-artifact.js";
import { SessionSummarySchema, TranslationMode } from "./types/session.js";
import { CalibrationConfig } from "./types/config.js";
import { authNotion } from "./auth/notion.js";
import { VERSION } from "./version.js";
import { generateArtifacts, resolveModes } from "./pipeline/generate.js";
import { StoryLedger } from "./ledger/store.js";
import { loadAllStories, migrateIndexToLedger } from "./ledger/migrate.js";
import { projectStory, StoryStatus } from "./types/ledger.js";
import { formatJudgeTable, judgeArtifact, JudgeResult, modeFromFrontmatter } from "./eval/judge.js";
import { hookLog, runPostCommitHook } from "./hooks/post-commit.js";
import {
  buildRepoGraph,
  buildStructuralDigest,
  CODEINTEL_PACKAGE,
  codeIntelStatus,
  EntityExtractor,
  loadCodeIntelRuntime,
  rankFiles,
  renderDigest,
  renderRepoMap,
} from "./codeintel/index.js";

const program = new Command();

function clientFor(config: CalibrationConfig) {
  return createClient({
    provider: config.provider,
    model: config.model,
    base_url: config.base_url,
    api_key: config.api_key,
  } as ProviderConfig);
}

function fail(err: unknown): never {
  console.error("Error:", (err as Error).message);
  process.exit(1);
}

/** Read stdin when it is piped; resolve "" for a TTY or if nothing arrives in time. */
function readStdin(timeoutMs = 2_000): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

program
  .name("skill-forge")
  .description("Transform coding sessions into career artifacts")
  .version(VERSION);

program
  .command("generate")
  .description("Generate career artifacts from the current session or git context")
  .option("-m, --mode <mode>", "Translation mode: interview-qa, portfolio-bullet, technical-deep-dive, all", "portfolio-bullet")
  .option("-j, --json <path>", "Path to pre-formed SessionSummary JSON (slash command path)")
  .option("-o, --output-dir <dir>", "Output directory (overrides config)")
  .option("-c, --connector <name>", `Connector: ${listConnectors().join(" | ")} (overrides config)`)
  .option("-p, --prompt-version <version>", "Prompt version to use (e.g. v2). Falls back to manifest active version.")
  .option("-s, --story <id>", "Story id: update this living artifact in place (versioned) instead of adding a new one")
  .option("-r, --range <range>", "Git range for the git path (e.g. main..HEAD, HEAD~3..HEAD). Default: HEAD~1..HEAD")
  .option("--with-code-facts", "With --json: also attach deterministic code facts computed from git for --range")
  .option("-f, --focus <text...>", "Focus lens for interview-qa mode (repeatable). Triggers the focus-scout subagent pass.")
  .option("--focus-effort <level>", "Focus subagent budget: low | medium | off (default: low, or config.focus_effort)")
  .option("--focus-deadline-ms <ms>", "Wall-clock deadline for the focus subagent call before graceful fallback")
  .action(async (opts) => {
    try {
      const config = loadCalibration();
      const client = clientFor(config);

      if (opts.outputDir) config.output_dir = opts.outputDir;
      if (opts.connector) config.connector = opts.connector;
      if (opts.focus && opts.focus.length > 0) config.focus = opts.focus;
      if (opts.focusEffort) {
        if (!["low", "medium", "off"].includes(opts.focusEffort)) {
          throw new Error(`--focus-effort must be one of: low, medium, off (got "${opts.focusEffort}")`);
        }
        config.focus_effort = opts.focusEffort;
      }
      if (opts.focusDeadlineMs) {
        const ms = Number(opts.focusDeadlineMs);
        if (!Number.isFinite(ms) || ms <= 0) {
          throw new Error(`--focus-deadline-ms must be a positive number (got "${opts.focusDeadlineMs}")`);
        }
        config.focus_deadline_ms = ms;
      }

      let rawJson: string | undefined;
      if (opts.json) {
        rawJson = readFileSync(opts.json, "utf-8");
      }

      const modes = resolveModes(opts.mode);
      const session = await ingestSession(client, rawJson, {
        range: opts.range,
        withCodeFacts: Boolean(opts.withCodeFacts),
      });
      if (opts.story) session.story_id = opts.story;

      const result = await generateArtifacts(client, config, session, modes, {
        promptVersion: opts.promptVersion,
      });
      for (const { mode, output, location } of result.artifacts) {
        if (config.connector === RETURN_ONLY) {
          console.log(formatReturnOnly(output, session, location));
          console.log("");
        } else {
          const version = output.artifact_version ? ` (v${output.artifact_version})` : "";
          console.log(`✓ ${mode}: ${location}${version}`);
        }
      }
      if (result.ledger_warning) console.warn(`[ledger] ${result.ledger_warning}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("list")
  .description("List generated artifacts")
  .option("-o, --output-dir <dir>", "Output directory (overrides config)")
  .action((opts) => {
    try {
      const config = loadCalibration();
      const resolved = resolveArtifactsDir(opts.outputDir ?? config.output_dir);
      const indexPath = join(resolved, "index.yml");

      try {
        const content = readFileSync(indexPath, "utf-8");
        console.log(content);
      } catch {
        console.log(`No artifacts found at ${resolved}`);
        console.log("Run `skill-forge generate` to create your first artifact.");
      }
    } catch (err) {
      fail(err);
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
        `skill-forge — ${last.entry.mode} — ${last.entry.one_liner}`
      );
      console.log(`✓ Shared: ${url}`);
      console.log(`  Source: ${last.filepath}`);
    } catch (err) {
      fail(err);
    }
  });

// ── judge ──────────────────────────────────────────────────────────────────
program
  .command("judge")
  .description("Score artifacts with the judge rubric (STAR, specificity, groundedness, metric honesty, calibration)")
  .argument("[artifact]", "Path to an artifact markdown file")
  .option("-j, --json <path>", "SessionSummary JSON the artifact was generated from")
  .option("-s, --story <id>", "Judge a ledger story's artifacts against its stored summary")
  .option("-m, --mode <mode>", "Artifact mode (default: read from the artifact's frontmatter)")
  .option("-o, --output-dir <dir>", "Artifacts directory (overrides config)")
  .option("-p, --prompt-version <version>", "Judge prompt version")
  .option("--format <format>", "table | json", "table")
  .action(async (artifactPath: string | undefined, opts) => {
    try {
      const config = loadCalibration();
      if (opts.outputDir) config.output_dir = opts.outputDir;
      const client = clientFor(config);
      const rows: Array<{ label: string; result: JudgeResult }> = [];

      if (opts.story) {
        const dir = resolveArtifactsDir(config.output_dir);
        const ledger = StoryLedger.forArtifactsDir(dir);
        const story = loadAllStories(dir, ledger).find((s) => s.story_id === opts.story);
        if (!story) throw new Error(`No story "${opts.story}" in ${dir}`);
        if (!story.summary) {
          throw new Error(
            `Story "${opts.story}" was migrated from a legacy index and has no stored summary. ` +
              "Judge its artifact file with --json <summary.json> instead."
          );
        }
        const session = projectStory(story);
        const targets = story.artifacts.filter((a) => !opts.mode || a.mode === opts.mode);
        if (targets.length === 0) throw new Error(`Story "${opts.story}" has no ${opts.mode ?? ""} artifacts`);
        for (const a of targets) {
          const markdown = readFileSync(join(dir, a.file), "utf-8");
          const result = await judgeArtifact(client, {
            mode: a.mode as TranslationMode,
            artifact: markdown,
            session,
            config,
            promptVersion: opts.promptVersion,
          });
          rows.push({ label: `${a.mode} v${a.version}`, result });
        }
      } else {
        if (!artifactPath || !opts.json) {
          throw new Error("Pass an artifact path and --json <summary.json>, or --story <id>.");
        }
        const markdown = readFileSync(artifactPath, "utf-8");
        const mode = (opts.mode ?? modeFromFrontmatter(markdown)) as TranslationMode | undefined;
        if (!mode) throw new Error("Could not determine the artifact mode; pass --mode.");
        const session = SessionSummarySchema.parse(JSON.parse(readFileSync(opts.json, "utf-8")));
        const result = await judgeArtifact(client, {
          mode,
          artifact: markdown,
          session,
          config,
          promptVersion: opts.promptVersion,
        });
        rows.push({ label: mode, result });
      }

      if (opts.format === "json") {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      console.log(formatJudgeTable(rows));
      for (const { label, result } of rows) {
        if (result.metric_honesty.unsupported.length || result.unsupported_claims.length) {
          console.log(`\n${label}:`);
          if (result.metric_honesty.unsupported.length) {
            console.log(`  ungrounded numbers: ${result.metric_honesty.unsupported.join(", ")}`);
          }
          for (const claim of result.unsupported_claims) console.log(`  unsupported claim: ${claim}`);
        }
      }
    } catch (err) {
      fail(err);
    }
  });

// ── stories (ledger) ───────────────────────────────────────────────────────
const storiesCmd = program
  .command("stories")
  .description("Inspect and manage the story ledger (living artifacts)");

function ledgerFor(outputDir?: string): { dir: string; ledger: StoryLedger } {
  const config = loadCalibration();
  const dir = resolveArtifactsDir(outputDir ?? config.output_dir);
  return { dir, ledger: StoryLedger.forArtifactsDir(dir) };
}

storiesCmd
  .command("list", { isDefault: true })
  .description("List stories (ledger stories plus not-yet-migrated legacy artifacts)")
  .option("-o, --output-dir <dir>", "Artifacts directory (overrides config)")
  .option("--status <status>", "Filter: candidate | approved | discarded")
  .action((opts) => {
    try {
      const { dir, ledger } = ledgerFor(opts.outputDir);
      const stories = loadAllStories(dir, ledger).filter((s) => !opts.status || s.status === opts.status);
      if (stories.length === 0) {
        console.log(`No stories at ${dir}`);
        return;
      }
      for (const s of stories) {
        const modes = s.artifacts.map((a) => `${a.mode}@v${a.version}`).join(", ") || "—";
        console.log(`${s.story_id}  v${s.version}  ${s.status}  [${s.origin}]  ${s.title}`);
        console.log(`    ${modes}`);
      }
    } catch (err) {
      fail(err);
    }
  });

storiesCmd
  .command("show")
  .description("Print one story as JSON")
  .argument("<id>", "Story id")
  .option("-o, --output-dir <dir>", "Artifacts directory (overrides config)")
  .action((id: string, opts) => {
    try {
      const { dir, ledger } = ledgerFor(opts.outputDir);
      const story = loadAllStories(dir, ledger).find((s) => s.story_id === id);
      if (!story) throw new Error(`No story "${id}" in ${dir}`);
      console.log(JSON.stringify(story, null, 2));
    } catch (err) {
      fail(err);
    }
  });

storiesCmd
  .command("migrate")
  .description("Persist legacy index.yml artifacts into the ledger as one-version stories (idempotent)")
  .option("-o, --output-dir <dir>", "Artifacts directory (overrides config)")
  .action((opts) => {
    try {
      const { dir, ledger } = ledgerFor(opts.outputDir);
      if (!existsSync(join(dir, "index.yml"))) {
        console.log(`No index.yml at ${dir} — nothing to migrate.`);
        return;
      }
      const { created, skipped } = migrateIndexToLedger(dir, ledger);
      console.log(`✓ Migrated ${created} legacy stor${created === 1 ? "y" : "ies"} (${skipped} already in the ledger).`);
    } catch (err) {
      fail(err);
    }
  });

for (const [name, status] of [
  ["approve", "approved"],
  ["discard", "discarded"],
] as Array<[string, StoryStatus]>) {
  storiesCmd
    .command(name)
    .description(`Mark a story ${status}`)
    .argument("<id>", "Story id")
    .option("-o, --output-dir <dir>", "Artifacts directory (overrides config)")
    .action((id: string, opts) => {
      try {
        const { ledger } = ledgerFor(opts.outputDir);
        const story = ledger.setStatus(id, status);
        console.log(`✓ ${story.story_id} → ${story.status}`);
      } catch (err) {
        fail(err);
      }
    });
}

// ── codeintel ──────────────────────────────────────────────────────────────
const codeintelCmd = program
  .command("codeintel")
  .description("Deterministic code facts: structural diff, complexity, repo map (L1 needs the codeintel companion)");

codeintelCmd
  .command("status")
  .description("Show which code-intelligence layer is active and which grammars are available")
  .action(async () => {
    const status = await codeIntelStatus();
    if (status.layer === "L1") {
      console.log(`✓ L1 (tree-sitter) — ${status.package}@${status.version}`);
      console.log(`  grammars: ${status.grammars.join(", ")}`);
    } else {
      console.log(`L0 (git only) — ${status.reason}`);
      console.log(`  For structural facts: npm i -g ${CODEINTEL_PACKAGE}`);
    }
  });

codeintelCmd
  .command("digest")
  .description("Print the structural digest for a git range (what the ingestor sends instead of a raw diff)")
  .argument("[range]", "Git range (default HEAD~1..HEAD)")
  .option("--json", "Print the code facts as JSON")
  .action(async (range: string | undefined, opts) => {
    try {
      const digest = await buildStructuralDigest({ root: process.cwd(), range });
      console.log(opts.json ? JSON.stringify(digest.facts, null, 2) : renderDigest(digest));
    } catch (err) {
      fail(err);
    }
  });

codeintelCmd
  .command("map")
  .description("Print a ranked repo map (central files and their signatures) within a token budget")
  .option("-b, --budget <tokens>", "Token budget", "1000")
  .option("-f, --focus <paths...>", "Personalize the ranking toward these files")
  .action(async (opts) => {
    try {
      const runtime = await loadCodeIntelRuntime();
      if (!runtime) throw new Error(`The repo map needs ${CODEINTEL_PACKAGE} (L1). Run \`skill-forge codeintel status\`.`);
      const graph = await buildRepoGraph(process.cwd(), new EntityExtractor(runtime));
      console.log(renderRepoMap(graph, rankFiles(graph, opts.focus ?? []), Number(opts.budget) || 1000));
    } catch (err) {
      fail(err);
    }
  });

// ── hook ───────────────────────────────────────────────────────────────────
const hookCmd = program
  .command("hook")
  .description("Entry points for host hooks (read the hook payload on stdin; always exit 0)");

hookCmd
  .command("post-commit")
  .description("Claude Code PostToolUse(Bash git commit) hook: generate an artifact from the new commit")
  .option("-m, --mode <mode>", "Translation mode (or 'all')", "portfolio-bullet")
  .action(async (opts) => {
    try {
      const raw = await readStdin();
      const result = await runPostCommitHook(raw, opts.mode);
      hookLog(
        result.ran
          ? `post-commit: wrote ${result.files?.join(", ")}`
          : `post-commit: skipped (${result.reason})`
      );
    } catch (err) {
      hookLog(`post-commit: error: ${(err as Error).message}`);
    }
    // A hook must never fail the host's tool call.
    process.exit(0);
  });

// ── auth ───────────────────────────────────────────────────────────────────
const authCmd = program
  .command("auth")
  .description("Authenticate with external connectors");

authCmd
  .command("notion")
  .description("Connect skill-forge to a Notion workspace (interactive setup)")
  .action(async () => {
    try {
      await authNotion();
    } catch (err) {
      fail(err);
    }
  });

authCmd
  .command("status")
  .description("Show which connectors are authenticated")
  .action(() => {
    const notionToken = process.env.NOTION_TOKEN;
    const notionDbId = process.env.NOTION_DATABASE_ID;
    const notion = notionToken && notionDbId
      ? `✓ notion   database: ${notionDbId.slice(0, 8)}…`
      : "✗ notion   not configured — run: skill-forge auth notion";
    const gist = process.env.GITHUB_TOKEN
      ? `✓ gist     token set`
      : "✗ gist     not configured — set GITHUB_TOKEN in .env";
    console.log("\nConnector status:");
    console.log(`  ${notion}`);
    console.log(`  ${gist}`);
  });

program.parse();
