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
import { Journal } from "./observer/journal.js";
import {
  findRepoRoot,
  loadObserveSettings,
  normalizeRepoPath,
  observeSettingsPath,
  saveObserveSettings,
} from "./observer/settings.js";
import { runObserverPass } from "./observer/worker.js";
import { reflectPending, reflectSession } from "./observer/reflector.js";
import { approveStory, describeCandidate, discardStory, listCandidates } from "./observer/inbox.js";
import { backfillTranscripts, parseDuration } from "./observer/backfill.js";
import { forgetSessions, sessionsForRepo } from "./observer/forget.js";
import { autoInstallTargets, detectHosts, getHostAdapter, HOST_ADAPTERS } from "./observer/hosts/registry.js";
import type { HostAdapter } from "./observer/hosts/types.js";
import { importEntireCheckpoints } from "./observer/importers/entire.js";
import { agentTraceStorePath, readAgentTraces, storeAgentTraces } from "./codeintel/attribution.js";
import { homedir } from "os";
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

// ── observer (always-on capture) ───────────────────────────────────────────
const observeCmd = program
  .command("observe")
  .description("Always-on observer: capture sessions as they happen (opt-in per repository)");

function repoArg(path: string | undefined): string {
  const root = findRepoRoot(path ?? process.cwd());
  if (!root) throw new Error(`${path ?? process.cwd()} is not inside a git repository.`);
  return root;
}

observeCmd
  .command("enable")
  .description("Enable observation for a repository (default: the current one)")
  .argument("[path]", "Repository path")
  .option("--confidential", "Confidential repo: local observer model only, proprietary names abstracted")
  .action((path: string | undefined, opts) => {
    try {
      const repo = repoArg(path);
      const settings = loadObserveSettings();
      const key = normalizeRepoPath(repo);
      if (!settings.enabled.some((p) => normalizeRepoPath(p) === key)) settings.enabled.push(repo);
      settings.confidential = settings.confidential.filter((p) => normalizeRepoPath(p) !== key);
      if (opts.confidential) settings.confidential.push(repo);
      saveObserveSettings(settings);
      console.log(`✓ Observation enabled for ${repo}${opts.confidential ? " (confidential)" : ""}`);
      console.log("  Hooks: `skill-forge observe install` (or install the Claude Code plugin). Settings: " + observeSettingsPath());
    } catch (err) {
      fail(err);
    }
  });

observeCmd
  .command("disable")
  .description("Disable observation for a repository (default: the current one)")
  .argument("[path]", "Repository path")
  .action((path: string | undefined) => {
    try {
      const repo = repoArg(path);
      const key = normalizeRepoPath(repo);
      const settings = loadObserveSettings();
      settings.enabled = settings.enabled.filter((p) => normalizeRepoPath(p) !== key);
      settings.confidential = settings.confidential.filter((p) => normalizeRepoPath(p) !== key);
      saveObserveSettings(settings);
      console.log(`✓ Observation disabled for ${repo}. Existing journals stay until \`skill-forge forget --repo\`.`);
    } catch (err) {
      fail(err);
    }
  });

observeCmd
  .command("status")
  .description("Show observer settings, enabled repositories, and journaled sessions")
  .action(() => {
    const settings = loadObserveSettings();
    const journal = new Journal();
    console.log(`Settings: ${observeSettingsPath()}`);
    console.log(`Observer: ${settings.observer} · notify ${settings.notify ? "on" : "off"} · question ${settings.question ? "on" : "off"} · ≤${settings.max_observer_calls_per_hour} observer calls/hour · journal TTL ${settings.retention_days}d`);
    console.log(`Enabled repositories (${settings.enabled.length}):`);
    for (const r of settings.enabled) {
      const conf = settings.confidential.some((c) => normalizeRepoPath(c) === normalizeRepoPath(r));
      console.log(`  ${r}${conf ? "  [confidential]" : ""}`);
    }
    const states = journal.allStates();
    console.log(`Journaled sessions: ${states.length} (${states.filter((s) => s.reflected_through_seq < s.seq).length} awaiting reflection)`);
    console.log(`Story candidates in inbox: ${journal.readInboxCount()}`);
  });

function installTargets(opts: { host?: string[]; all?: boolean }): HostAdapter[] {
  if (opts.all) return autoInstallTargets(homedir());
  return (opts.host ?? []).map((h) => {
    const a = getHostAdapter(h);
    if (!a) throw new Error(`Unknown host "${h}". Hosts: ${Object.keys(HOST_ADAPTERS).join(", ")}`);
    return a;
  });
}

function printHosts(): void {
  console.log("Hosts (✓ = detected on this machine):");
  for (const { adapter, detected } of detectHosts(homedir())) {
    const tag = adapter.confidence === "verified" ? "" : ` [${adapter.confidence}]`;
    console.log(`  ${detected ? "✓" : " "} ${adapter.name.padEnd(12)} ${adapter.label}${tag}`);
    if (adapter.notes) console.log(`      ${adapter.notes}`);
  }
}

observeCmd
  .command("hosts")
  .description("List supported hosts, which are installed here, and how sure we are of each payload schema")
  .action(() => printHosts());

observeCmd
  .command("install")
  .description("Write observer hooks for agent hosts (Claude Code, Codex, Cursor, Gemini CLI, Copilot CLI, Kiro) or git")
  .option("--host <names...>", "Hosts to install for (see `skill-forge observe hosts`)")
  .option("--all", "Every detected host with a verified or partial schema (never Kiro or git)")
  .option("--scope <scope>", "user | project", "user")
  .action((opts) => {
    try {
      if (!["user", "project"].includes(opts.scope)) throw new Error("--scope must be user or project");
      const targets = installTargets(opts);
      if (targets.length === 0) {
        printHosts();
        console.log("\nNothing written. Re-run with --host <name…> or --all.");
        return;
      }
      for (const adapter of targets) {
        const { path, events } = adapter.install({ home: homedir(), projectDir: process.cwd(), scope: opts.scope });
        console.log(`✓ ${adapter.label}: ${path} (${events.join(", ")})`);
        if (adapter.notes) console.log(`  note: ${adapter.notes}`);
      }
      console.log("  Capture is a no-op until a repository is enabled: `skill-forge observe enable`.");
    } catch (err) {
      fail(err);
    }
  });

observeCmd
  .command("uninstall")
  .description("Remove observer hooks for the given hosts (default: claude-code)")
  .option("--host <names...>", "Hosts to uninstall", ["claude-code"])
  .option("--scope <scope>", "user | project", "user")
  .action((opts) => {
    try {
      for (const adapter of installTargets({ host: opts.host })) {
        const { path, removed } = adapter.uninstall({ home: homedir(), projectDir: process.cwd(), scope: opts.scope });
        console.log(removed ? `✓ ${adapter.label}: removed from ${path}` : `- ${adapter.label}: nothing to remove in ${path}`);
      }
    } catch (err) {
      fail(err);
    }
  });

observeCmd
  .command("purge")
  .description("Delete raw journals older than the retention TTL (observations and stories are kept)")
  .action(() => {
    const settings = loadObserveSettings();
    const removed = new Journal().purge(settings.retention_days);
    console.log(`✓ Purged ${removed.length} journal(s) older than ${settings.retention_days} days.`);
  });

// Hidden: the detached worker the capture hooks spawn.
program
  .command("observe-worker", { hidden: true })
  .option("--session <id>", "Session to observe")
  .option("--force", "Ignore the hourly observer budget")
  .option("--reflect", "After observing, reflect the session into a story")
  .option("--catch-up", "Reflect every session whose reflection is behind")
  .action(async (opts) => {
    const log = (line: string) => hookLog(`observer: ${line}`);
    try {
      if (opts.catchUp) {
        const results = await reflectPending();
        log(`catch-up reflected ${results.length} session(s)`);
      } else if (opts.session) {
        if (opts.reflect) {
          const r = await reflectSession(opts.session);
          log(`${opts.session}: ${r.story ? `story ${r.story.story_id} v${r.story.version}` : r.skipped}`);
        } else {
          const r = await runObserverPass(opts.session, { force: Boolean(opts.force) });
          log(`${opts.session}: ${r.skipped ?? `${r.observations.length} observation(s)`}`);
        }
      }
    } catch (err) {
      log(`error: ${(err as Error).message}`);
    }
    process.exit(0);
  });

program
  .command("reflect")
  .description("Merge observed sessions into story candidates (and refresh approved living artifacts)")
  .option("--session <id>", "Reflect one session")
  .option("--all", "Reflect every session with unreflected events, not only ended/idle ones")
  .option("--no-regenerate", "Don't regenerate artifacts of approved stories")
  .action(async (opts) => {
    try {
      const results = opts.session
        ? [{ session: opts.session, ...(await reflectSession(opts.session, { regenerate: opts.regenerate })) }]
        : await reflectPending({ all: Boolean(opts.all), regenerate: opts.regenerate });
      if (results.length === 0) console.log("Nothing to reflect.");
      for (const r of results) {
        console.log(
          r.story
            ? `✓ ${r.session} → ${r.story.story_id} v${r.story.version} (${r.story.status})${r.regenerated?.length ? `, regenerated ${r.regenerated.length} artifact(s)` : ""}`
            : `- ${r.session}: ${r.skipped}`
        );
      }
    } catch (err) {
      fail(err);
    }
  });

const inboxCmd = program
  .command("inbox")
  .description("Review story candidates from the observer (nothing is published without approval)");

inboxCmd
  .command("list", { isDefault: true })
  .description("List story candidates")
  .action(() => {
    try {
      const config = loadCalibration();
      const ledger = StoryLedger.forArtifactsDir(resolveArtifactsDir(config.output_dir));
      const candidates = listCandidates({ config, ledger });
      if (candidates.length === 0) {
        console.log("Inbox is empty.");
        return;
      }
      for (const s of candidates) console.log(describeCandidate(s, ledger.listObservations(s.session_ids[0]).length));
      console.log("\nApprove: `skill-forge inbox approve <id> [--mode all]` · Discard: `skill-forge inbox discard <id>`");
    } catch (err) {
      fail(err);
    }
  });

inboxCmd
  .command("show")
  .description("Show a candidate's story and the observations behind it")
  .argument("<id>", "Story id")
  .action((id: string) => {
    try {
      const config = loadCalibration();
      const ledger = StoryLedger.forArtifactsDir(resolveArtifactsDir(config.output_dir));
      const story = ledger.get(id);
      if (!story) throw new Error(`No story "${id}"`);
      console.log(`${story.title}  (${story.status}, v${story.version})\n`);
      if (story.summary) {
        console.log(`${story.summary.one_liner}\n`);
        for (const t of story.summary.tradeoffs) console.log(`  tradeoff: ${t.decision} — ${t.reasoning} (vs ${t.alternative_considered})`);
        for (const d of story.summary.dead_ends) console.log(`  dead end: ${d}`);
      }
      console.log("\nObservations:");
      for (const sid of story.session_ids) {
        for (const o of ledger.listObservations(sid)) console.log(`  [${o.kind} ${o.confidence}] ${o.claim}`);
      }
    } catch (err) {
      fail(err);
    }
  });

inboxCmd
  .command("approve")
  .description("Approve a candidate and generate artifacts from it")
  .argument("<id>", "Story id")
  .option("-m, --mode <mode>", "Mode(s) to generate: interview-qa, portfolio-bullet, technical-deep-dive, all", "portfolio-bullet")
  .option("--no-generate", "Approve without generating")
  .action(async (id: string, opts) => {
    try {
      const { story, generated } = await approveStory(id, opts.generate ? resolveModes(opts.mode) : false);
      console.log(`✓ ${story.story_id} approved`);
      for (const a of generated?.artifacts ?? []) console.log(`✓ ${a.mode}: ${a.location}`);
    } catch (err) {
      fail(err);
    }
  });

inboxCmd
  .command("discard")
  .description("Discard a candidate")
  .argument("<id>", "Story id")
  .action((id: string) => {
    try {
      console.log(`✓ ${discardStory(id).story_id} discarded`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("backfill")
  .description("Import existing Claude Code transcripts for enabled repositories, then observe and reflect them")
  .option("--since <duration>", "How far back (e.g. 30d, 12h, 2w)", "30d")
  .option("--no-llm", "Import into the journal only; skip the observer/reflector passes")
  .option("--force", "Re-import sessions already in the journal")
  .action(async (opts) => {
    try {
      const imported = backfillTranscripts({ sinceMs: Date.now() - parseDuration(opts.since), force: Boolean(opts.force) });
      for (const s of imported.skipped.filter((x) => x.reason !== "repository not enabled for observation")) {
        console.log(`- ${s.file}: ${s.reason}`);
      }
      console.log(`✓ Imported ${imported.imported.length} session(s) from enabled repositories.`);
      if (!opts.llm) return;
      for (const s of imported.imported) {
        const r = await reflectSession(s.session, { regenerate: false });
        console.log(r.story ? `  ✓ ${s.session} → ${r.story.title}` : `  - ${s.session}: ${r.skipped}`);
      }
      console.log("Review with `skill-forge inbox`.");
    } catch (err) {
      fail(err);
    }
  });

program
  .command("forget")
  .description("Delete observed data: raw journals, observations, and observer-made stories")
  .option("--session <id>", "One session")
  .option("--repo <path>", "Every session from a repository")
  .action((opts) => {
    try {
      if (!opts.session && !opts.repo) throw new Error("Pass --session <id> or --repo <path>.");
      const config = loadCalibration();
      const journal = new Journal();
      const ledger = StoryLedger.forArtifactsDir(resolveArtifactsDir(config.output_dir));
      const sessions = opts.session ? [opts.session] : sessionsForRepo(journal, opts.repo);
      const r = forgetSessions(sessions, journal, ledger);
      console.log(`✓ Forgot ${r.sessions.length} session(s) and ${r.stories.length} observer stor${r.stories.length === 1 ? "y" : "ies"}.`);
    } catch (err) {
      fail(err);
    }
  });

// ── importers ──────────────────────────────────────────────────────────────
const importCmd = program.command("import").description("Import evidence from other tools (Entire checkpoints, Agent Trace records)");

importCmd
  .command("entire")
  .description("Import Entire CLI checkpoints of this repository into the observer journal [unverified listing schema]")
  .option("--limit <n>", "Most recent checkpoints to import", "50")
  .option("--no-llm", "Import only; skip the observer/reflector passes")
  .action(async (opts) => {
    try {
      const r = importEntireCheckpoints({ limit: Number(opts.limit) || 50 });
      for (const s of r.skipped) console.log(`- ${s.checkpoint}: ${s.reason}`);
      console.log(`✓ Imported ${r.imported.length} checkpoint(s).`);
      if (!opts.llm) return;
      for (const i of r.imported) {
        const res = await reflectSession(i.session, { regenerate: false });
        console.log(res.story ? `  ✓ ${i.checkpoint} → ${res.story.title}` : `  - ${i.checkpoint}: ${res.skipped}`);
      }
    } catch (err) {
      fail(err);
    }
  });

importCmd
  .command("agent-trace")
  .description("Import Agent Trace records (agent-trace.dev) so code facts can attribute AI-written lines")
  .argument("<paths...>", "Trace files (.json / .jsonl) or directories")
  .action((paths: string[]) => {
    try {
      const { records, invalid } = readAgentTraces(paths);
      const added = storeAgentTraces(records);
      console.log(`✓ Imported ${added} new trace record(s) (${records.length - added} already known, ${invalid} invalid) into ${agentTraceStorePath()}`);
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
