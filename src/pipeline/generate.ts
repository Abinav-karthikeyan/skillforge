import { LLMClient } from "../claude/types.js";
import { resolveArtifactsDir } from "../config/paths.js";
import { StoryLedger } from "../ledger/store.js";
import { createConnector } from "../output/connectors/factory.js";
import { translateInterviewQA } from "../translators/interview-qa.js";
import { translatePortfolioBullet } from "../translators/portfolio-bullet.js";
import { translateTechnicalDeepDive } from "../translators/technical-deep-dive.js";
import { CalibrationConfig } from "../types/config.js";
import { Story } from "../types/ledger.js";
import { SessionSummary, TranslationMode, TranslatorOutput } from "../types/session.js";

export const ALL_MODES: TranslationMode[] = ["interview-qa", "portfolio-bullet", "technical-deep-dive"];

export function resolveModes(mode: string): TranslationMode[] {
  if (mode === "all") return [...ALL_MODES];
  if (!(ALL_MODES as string[]).includes(mode)) {
    throw new Error(`Unknown mode "${mode}". Valid: ${ALL_MODES.join(", ")}, all`);
  }
  return [mode as TranslationMode];
}

export async function runTranslator(
  mode: TranslationMode,
  client: LLMClient,
  session: SessionSummary,
  config: CalibrationConfig,
  promptVersion?: string,
  focus?: string | string[]
): Promise<TranslatorOutput> {
  if (mode === "portfolio-bullet") return translatePortfolioBullet(client, session, config, promptVersion);
  if (mode === "interview-qa") {
    return translateInterviewQA(client, session, config, { promptVersion, focusOverride: focus });
  }
  return translateTechnicalDeepDive(client, session, config, promptVersion);
}

export interface GeneratedArtifact {
  mode: TranslationMode;
  output: TranslatorOutput;
  /** Where the connector put it — a local path, or a URL for remote connectors. */
  location: string;
}

export interface GenerateResult {
  artifacts: GeneratedArtifact[];
  /** The ledger story this run created or updated (undefined if the ledger write failed). */
  story?: Story;
  ledger_warning?: string;
}

/**
 * The shared generate pipeline (CLI, MCP, and the commit hook): translate
 * each mode, write through the configured connector, then record the run as
 * a story in the ledger. The ledger write is deliberately non-fatal — the
 * artifacts are already on disk, and losing a ledger entry is recoverable via
 * `skill-forge stories migrate`, whereas failing the run would lose the work.
 */
export async function generateArtifacts(
  client: LLMClient,
  config: CalibrationConfig,
  session: SessionSummary,
  modes: TranslationMode[],
  opts: { promptVersion?: string; focus?: string | string[] } = {}
): Promise<GenerateResult> {
  const connector = createConnector(config);
  const artifacts: GeneratedArtifact[] = [];
  for (const mode of modes) {
    const output = await runTranslator(mode, client, session, config, opts.promptVersion, opts.focus);
    const location = await connector.write(output, session);
    artifacts.push({ mode, output, location });
  }

  try {
    const ledger = StoryLedger.forArtifactsDir(resolveArtifactsDir(config.output_dir));
    const story = ledger.recordGeneration(session, artifacts);
    return { artifacts, story };
  } catch (err) {
    return { artifacts, ledger_warning: `story ledger not updated: ${(err as Error).message}` };
  }
}
