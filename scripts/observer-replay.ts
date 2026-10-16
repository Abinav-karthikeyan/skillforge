#!/usr/bin/env npx tsx
/**
 * Observer replay eval (plan_v3 §3.7). For each session fixture in
 * tests/fixtures/sessions/ (synthesized hook-payload sequences with gold
 * dead ends, debugging arcs, and tradeoffs):
 *
 *   observer  — replay every payload through live capture, then one observer
 *               pass over the full journal (what the always-on observer sees)
 *   baseline  — one pass over only what survives to the end of a v2 session:
 *               the compaction summary, the final assistant message, and the
 *               commits (an end-of-session pass on a compacted transcript)
 *
 * Recall = gold items whose keywords appear in some observation. Uses the
 * configured provider — this script spends LLM calls (2 per fixture).
 *
 *   npx tsx scripts/observer-replay.ts
 *   npx tsx scripts/observer-replay.ts --fixtures rate-limiter
 */
import { execFileSync } from "child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};

interface Fixture {
  name: string;
  session_id: string;
  gold: Record<"dead_ends" | "debug_arcs" | "tradeoffs", Array<{ keywords: string[] }>>;
  payloads: Array<Record<string, unknown>>;
}

const fixturesDir = join(process.cwd(), "tests", "fixtures", "sessions");
const names = flag("fixtures")?.split(",") ?? readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

const home = mkdtempSync(join(tmpdir(), "sf-replay-home-"));
process.env.SKILL_FORGE_HOME = home;

const { loadCalibration } = await import("../src/config/calibration.js");
const { capturePayload } = await import("../src/observer/capture.js");
const { Journal } = await import("../src/observer/journal.js");
const { DEFAULT_OBSERVE_SETTINGS } = await import("../src/observer/settings.js");
const { runObserverPass } = await import("../src/observer/worker.js");
const { createObserverClient } = await import("../src/observer/llm.js");
const { StoryLedger } = await import("../src/ledger/store.js");

const config = loadCalibration();
const client = createObserverClient(config, false);

function recall(gold: Fixture["gold"], claims: string[]): { hit: number; total: number; missed: string[] } {
  const text = claims.join("\n").toLowerCase();
  let hit = 0;
  let total = 0;
  const missed: string[] = [];
  for (const [kind, items] of Object.entries(gold)) {
    for (const item of items) {
      total++;
      if (item.keywords.some((k) => text.includes(k.toLowerCase()))) hit++;
      else missed.push(`${kind}: ${item.keywords[0]}`);
    }
  }
  return { hit, total, missed };
}

const rows: string[] = [];
let obsHit = 0;
let baseHit = 0;
let total = 0;

for (const name of names) {
  const fx = JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), "utf-8")) as Fixture;
  const repo = mkdtempSync(join(tmpdir(), "sf-replay-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# replay\n");
  const settings = { ...DEFAULT_OBSERVE_SETTINGS, enabled: [repo], observer: "off" as const };

  const run = async (session: string, payloads: Array<Record<string, unknown>>) => {
    const journal = new Journal(join(home, "journal"));
    const ledger = new StoryLedger(join(home, `ledger-${session}`));
    for (const p of payloads) capturePayload(JSON.stringify({ session_id: session, cwd: repo, ...p }), { settings, journal, spawn: () => true });
    const r = await runObserverPass(session, { journal, ledger, config, settings, client, force: true });
    return r.observations.map((o) => `[${o.kind}] ${o.claim}`);
  };

  // What survives to the end of a v2 session: compaction summary, last assistant message, commits.
  const lastStop = [...fx.payloads].reverse().find((p) => p.hook_event_name === "Stop");
  const survivors = fx.payloads.filter(
    (p) => p.hook_event_name === "PostCompact" || p === lastStop || (p.hook_event_name === "PostToolUse" && /git\b.*\bcommit/.test(String((p.tool_input as { command?: string })?.command ?? "")))
  );

  const observer = await run(`${fx.session_id}-observer`, fx.payloads);
  const baseline = await run(`${fx.session_id}-baseline`, survivors);
  const o = recall(fx.gold, observer);
  const b = recall(fx.gold, baseline);
  obsHit += o.hit;
  baseHit += b.hit;
  total += o.total;
  rows.push(`| ${name} | ${o.hit}/${o.total} | ${b.hit}/${b.total} | ${o.missed.join("; ") || "—"} |`);
  rmSync(repo, { recursive: true, force: true });
}

console.log("| fixture | observer recall | end-of-session baseline | observer missed |");
console.log("| --- | --- | --- | --- |");
console.log(rows.join("\n"));
console.log(`\nTotal: observer ${obsHit}/${total} (${Math.round((100 * obsHit) / total)}%), baseline ${baseHit}/${total} (${Math.round((100 * baseHit) / total)}%).`);
rmSync(home, { recursive: true, force: true });
