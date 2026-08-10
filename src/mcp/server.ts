#!/usr/bin/env node
import "../config/preload-env.js"; // must be the first import — loads .env before anything else
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, ProviderConfig } from "../claude/client.js";
import { loadCalibration } from "../config/calibration.js";
import { ingestSession } from "../ingestor/index.js";
import { translatePortfolioBullet } from "../translators/portfolio-bullet.js";
import { translateInterviewQA } from "../translators/interview-qa.js";
import { translateTechnicalDeepDive } from "../translators/technical-deep-dive.js";
import { createConnector } from "../output/connectors/factory.js";
import { GistConnector } from "../output/connectors/gist.js";
import { readLastArtifact } from "../output/last-artifact.js";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { SessionSummarySchema, TranslationMode, TranslatorOutput } from "../types/session.js";
import { SessionSummary } from "../types/session.js";
import { CalibrationConfig } from "../types/config.js";
import { LLMClient } from "../claude/types.js";

const server = new McpServer({
  name: "career-mode",
  version: "0.1.0",
});

const MODE_ENUM = z.enum(["interview-qa", "portfolio-bullet", "technical-deep-dive", "all"]);

async function runTranslator(
  mode: TranslationMode,
  client: LLMClient,
  session: SessionSummary,
  config: CalibrationConfig
): Promise<TranslatorOutput> {
  if (mode === "portfolio-bullet") return translatePortfolioBullet(client, session, config);
  if (mode === "interview-qa") return translateInterviewQA(client, session, config);
  return translateTechnicalDeepDive(client, session, config);
}

server.registerTool(
  "generate_career_artifact",
  {
    title: "Generate career artifact",
    description:
      "Translate a coding session into an interview-ready artifact (STAR-format Q&A, resume bullets, or a technical deep-dive) " +
      "and write it to the configured output directory. Pass `session_summary` with the structured session context " +
      "(problem, approach, tradeoffs, dead ends, tech stack) synthesized from the current conversation for the richest result. " +
      "If omitted, falls back to summarizing the local git log/diff.",
    inputSchema: {
      mode: MODE_ENUM.default("portfolio-bullet").describe(
        "Which artifact(s) to generate. 'all' generates all three modes."
      ),
      session_summary: SessionSummarySchema.partial({ session_id: true, timestamp: true, source_tool: true })
        .optional()
        .describe(
          "Structured session context. Synthesize this from the conversation: one_liner, problem_statement, approach, " +
            "tradeoffs, dead_ends, technologies, patterns_used, complexity_signals. Omit to fall back to git log/diff."
        ),
      output_dir: z.string().optional().describe("Override the configured output directory."),
      connector: z
        .enum(["local", "gist"])
        .optional()
        .describe("Output connector: 'local' (default) or 'gist' (also pushes each artifact to a GitHub Gist)."),
    },
  },
  async ({ mode, session_summary, output_dir, connector }) => {
    try {
      const config = loadCalibration();
      if (output_dir) config.output_dir = output_dir;
      if (connector) config.connector = connector;

      const client = createClient({
        provider: config.provider,
        model: config.model,
        base_url: config.base_url,
        api_key: config.api_key,
      } as ProviderConfig);

      const rawJson = session_summary
        ? JSON.stringify({
            session_id: session_summary.session_id ?? crypto.randomUUID(),
            timestamp: session_summary.timestamp ?? new Date().toISOString(),
            source_tool: session_summary.source_tool ?? "claude-code",
            summary: session_summary.summary,
          })
        : undefined;

      const session = await ingestSession(client, rawJson);
      const writer = createConnector(config);

      const modes: TranslationMode[] =
        mode === "all" ? ["interview-qa", "portfolio-bullet", "technical-deep-dive"] : [mode];

      const sections: string[] = [];
      for (const m of modes) {
        const output = await runTranslator(m, client, session, config);
        const location = await writer.write(output, session);
        sections.push(`### ${m}\nWritten to: ${location}\n\n${output.content}`);
      }

      return { content: [{ type: "text", text: sections.join("\n\n---\n\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "list_career_artifacts",
  {
    title: "List career artifacts",
    description: "List previously generated career artifacts from the output directory's index.",
    inputSchema: {
      output_dir: z.string().optional().describe("Override the configured output directory."),
    },
  },
  async ({ output_dir }) => {
    try {
      const config = loadCalibration();
      const dir = output_dir ?? config.output_dir ?? "~/.career-mode/artifacts";
      const resolved = dir.startsWith("~") ? join(homedir(), dir.slice(2)) : dir;
      const indexPath = join(resolved, "index.yml");

      try {
        const content = readFileSync(indexPath, "utf-8");
        return { content: [{ type: "text", text: content }] };
      } catch {
        return {
          content: [
            { type: "text", text: `No artifacts found at ${resolved}. Run generate_career_artifact first.` },
          ],
        };
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "share_last_artifact",
  {
    title: "Share last artifact via GitHub Gist",
    description:
      "Push the most recently generated artifact to a GitHub Gist and return the shareable URL. " +
      "Useful for showing off an interview answer or portfolio bullet after generating it. " +
      "Requires GITHUB_TOKEN in the environment or `gist_token` in career-mode.config.yaml (needs `gist` scope only).",
    inputSchema: {
      output_dir: z.string().optional().describe("Override the configured artifacts directory."),
      is_public: z
        .boolean()
        .optional()
        .describe("Create a public gist. Defaults to secret (unlisted)."),
    },
  },
  async ({ output_dir, is_public }) => {
    try {
      const config = loadCalibration();
      const last = readLastArtifact(output_dir ?? config.output_dir);
      const gist = new GistConnector({
        token: config.gist_token,
        isPublic: is_public ?? config.gist_public,
      });
      const url = await gist.createGist(
        last.filename,
        last.markdown,
        `Career Mode — ${last.entry.mode} — ${last.entry.one_liner}`
      );
      return {
        content: [
          {
            type: "text",
            text: `Shared: ${url}\nSource: ${last.filepath}\nMode: ${last.entry.mode}\nOne-liner: ${last.entry.one_liner}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Career Mode MCP server failed to start:", err);
  process.exit(1);
});
