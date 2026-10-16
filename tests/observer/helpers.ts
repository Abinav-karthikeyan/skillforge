import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Journal } from "../../src/observer/journal.js";
import { DEFAULT_OBSERVE_SETTINGS, ObserveSettings } from "../../src/observer/settings.js";
import { TempRepo } from "../codeintel/helpers.js";

export interface SessionFixture {
  name: string;
  description: string;
  session_id: string;
  gold: {
    dead_ends: Array<{ detector: string; keywords: string[] }>;
    debug_arcs: Array<{ detector: string; keywords: string[] }>;
    tradeoffs: Array<{ detector: string; keywords: string[] }>;
    dependencies: string[];
    checkpoints: number;
    snapshots: number;
  };
  payloads: Array<Record<string, unknown>>;
}

export const FIXTURE_NAMES = ["rate-limiter", "auth-service", "memory-leak"];

export function loadSessionFixture(name: string): SessionFixture {
  return JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "sessions", `${name}.json`), "utf-8"));
}

/** An isolated observer world: temp SKILL_FORGE_HOME, an enabled git repo, a journal. */
export class ObserverSandbox {
  readonly home: string;
  readonly repo: TempRepo;
  readonly journal: Journal;
  readonly settings: ObserveSettings;
  private previousHome: string | undefined;

  constructor(overrides: Partial<ObserveSettings> = {}) {
    this.home = mkdtempSync(join(tmpdir(), "sf-observer-home-"));
    this.previousHome = process.env.SKILL_FORGE_HOME;
    process.env.SKILL_FORGE_HOME = this.home;
    this.repo = new TempRepo();
    this.repo.write({ "README.md": "# fixture\n" }).commit("init");
    mkdirSync(join(this.home, "journal"), { recursive: true });
    this.journal = new Journal(join(this.home, "journal"));
    this.settings = { ...DEFAULT_OBSERVE_SETTINGS, enabled: [this.repo.root], ...overrides };
  }

  /** Stamp a fixture payload with this sandbox's repo and session. */
  payload(p: Record<string, unknown>, sessionId: string): string {
    return JSON.stringify({ session_id: sessionId, cwd: this.repo.root, ...p });
  }

  dispose(): void {
    if (this.previousHome === undefined) delete process.env.SKILL_FORGE_HOME;
    else process.env.SKILL_FORGE_HOME = this.previousHome;
    this.repo.dispose();
    rmSync(this.home, { recursive: true, force: true });
  }
}
