#!/usr/bin/env node
import "../config/preload-env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, ProviderConfig } from "../claude/client.js";
import { loadCalibration } from "../config/calibration.js";
import { ingestSession } from "../ingestor/index.js";
import { listConnectors } from "../output/connectors/factory.js";
import { RETURN_ONLY, formatReturnOnly } from "../output/return-only.js";
import { GistConnector } from "../output/connectors/gist.js";
import { NotionConnector } from "../output/connectors/notion.js";
import { readLastArtifact } from "../output/last-artifact.js";
import { readFileSync } from "fs";
import { join } from "path";
import { resolveArtifactsDir } from "../config/paths.js";
import { SessionSummarySchema } from "../types/session.js";
import { generateArtifacts, resolveModes } from "../pipeline/generate.js";
import { VERSION } from "../version.js";

function parseFrontmatterArray(markdown: string, key: string): string[] {
  const match = markdown.match(new RegExp(`^${key}:\\s*\\[(.*)\\]`, "m"));
  if (!match) return [];
  return match[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

const server = new McpServer({
  name: "skill-forge",
  version: VERSION,
});

const MODE_ENUM = z.enum(["interview-qa", "portfolio-bullet", "technical-deep-dive", "all"]);

const generateToolConfig = {
  title: "Generate skill-forge artifact",
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
          "tradeoffs, dead_ends, technologies, patterns_used, complexity_signals. Omit to fall back to git log/diff. " +
          "Set story_id to update an existing living artifact (versioned in place) instead of adding a new one."
      ),
    output_dir: z.string().optional().describe("Override the configured output directory."),
    connector: z
      .string()
      .optional()
      .describe(`Output connector (${listConnectors().join(", ")}). Defaults to 'local'.`),
    prompt_version: z
      .string()
      .optional()
      .describe("Prompt version to use (e.g. 'v2'). Falls back to SKILL_FORGE_PROMPT_VERSION env var, then manifest active version."),
    focus: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Interview-qa only: focus lens (e.g. 'system-design tradeoffs', 'cross-team influence'). " +
          "Triggers the focus-scout subagent under the configured focus_effort budget."
      ),
    focus_effort: z
      .enum(["low", "medium", "off"])
      .optional()
      .describe("Focus subagent budget tier. Defaults to config.focus_effort or 'low'."),
  },
} as const;

const generateHandler = async ({ mode, session_summary, output_dir, connector, prompt_version, focus, focus_effort }: any): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
    try {
      const config = loadCalibration();
      if (output_dir) config.output_dir = output_dir;
      if (connector) config.connector = connector;
      if (focus_effort) config.focus_effort = focus_effort;

      const client = createClient({
        provider: config.provider,
        model: config.model,
        base_url: config.base_url,
        api_key: config.api_key,
      } as ProviderConfig);

      const rawJson = session_summary
        ? JSON.stringify({
            session_id: session_summary.session_id ?? crypto.randomUUID(),
            story_id: session_summary.story_id,
            timestamp: session_summary.timestamp ?? new Date().toISOString(),
            source_tool: session_summary.source_tool ?? "claude-code",
            summary: session_summary.summary,
          })
        : undefined;

      const session = await ingestSession(client, rawJson);
      const result = await generateArtifacts(client, config, session, resolveModes(mode), {
        promptVersion: prompt_version,
        focus,
      });

      const returnOnly = config.connector === RETURN_ONLY;
      const sections = result.artifacts.map(({ mode: m, output, location }) =>
        returnOnly
          ? formatReturnOnly(output, session, location)
          : `### ${m}\nWritten to: ${location}` +
            (output.artifact_version ? ` (v${output.artifact_version})` : "") +
            `\n\n${output.content}`
      );
      if (result.story) {
        sections.push(`Story: ${result.story.story_id} (v${result.story.version}, ${result.story.status})`);
      }

      return { content: [{ type: "text", text: sections.join("\n\n---\n\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
};

// Primary (current) tool name.
server.registerTool("generate_skill_forge_artifact", generateToolConfig, generateHandler);
// Deprecated alias — kept for one release so existing MCP hosts keep working.
// Remove after the naming migration window (see src/config/paths.ts).
server.registerTool(
  "generate_career_artifact",
  { ...generateToolConfig, description: `[DEPRECATED: use generate_skill_forge_artifact] ${generateToolConfig.description}` },
  generateHandler
);

const listToolConfig = {
  title: "List skill-forge artifacts",
  description: "List previously generated artifacts from the output directory's index.",
  inputSchema: {
    output_dir: z.string().optional().describe("Override the configured output directory."),
  },
} as const;

const listHandler = async ({ output_dir }: any): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
    try {
      const config = loadCalibration();
      const resolved = resolveArtifactsDir(output_dir ?? config.output_dir);
      const indexPath = join(resolved, "index.yml");

      try {
        const content = readFileSync(indexPath, "utf-8");
        return { content: [{ type: "text", text: content }] };
      } catch {
        return {
          content: [
            { type: "text", text: `No artifacts found at ${resolved}. Run generate_skill_forge_artifact first.` },
          ],
        };
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
};

server.registerTool("list_skill_forge_artifacts", listToolConfig, listHandler);
// Deprecated alias — remove after the naming migration window.
server.registerTool(
  "list_career_artifacts",
  { ...listToolConfig, description: `[DEPRECATED: use list_skill_forge_artifacts] ${listToolConfig.description}` },
  listHandler
);

server.registerTool(
  "share_last_artifact",
  {
    title: "Share last artifact",
    description:
      "Push the most recently generated artifact to a destination (GitHub Gist or Notion) and return the shareable URL. " +
      "Useful for showing off an interview answer or portfolio bullet after generating it. " +
      "For Gist: requires GITHUB_TOKEN or `gist_token` in config (needs `gist` scope). " +
      "For Notion: requires NOTION_TOKEN and `notion_database_id` in config.",
    inputSchema: {
      output_dir: z.string().optional().describe("Override the configured artifacts directory."),
      destination: z
        .enum(["gist", "notion"])
        .default("gist")
        .describe("Where to share: 'gist' (GitHub Gist) or 'notion' (Notion database)."),
      is_public: z
        .boolean()
        .optional()
        .describe("For gist: create a public gist. Defaults to secret (unlisted)."),
    },
  },
  async ({ output_dir, destination, is_public }) => {
    try {
      const config = loadCalibration();
      const last = readLastArtifact(output_dir ?? config.output_dir);

      let url: string;
      if (destination === "notion") {
        const notion = new NotionConnector({
          token: config.notion_token,
          databaseId: config.notion_database_id,
          propertyMap: config.notion_property_map,
        });
        const techs = parseFrontmatterArray(last.markdown, "technologies");
        url = await notion.writePreRendered(last.markdown, {
          oneLiner: last.entry.one_liner,
          mode: last.entry.mode,
          date: last.entry.timestamp.slice(0, 10),
          technologies: techs,
          patterns: [],
        });
      } else {
        const gist = new GistConnector({
          token: config.gist_token,
          isPublic: is_public ?? config.gist_public,
        });
        url = await gist.createGist(
          last.filename,
          last.markdown,
          `skill-forge — ${last.entry.mode} — ${last.entry.one_liner}`
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Shared to ${destination}: ${url}\nSource: ${last.filepath}\nMode: ${last.entry.mode}\nOne-liner: ${last.entry.one_liner}`,
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

server.registerTool(
  "notion_auth_status",
  {
    title: "Notion auth status",
    description:
      "Check whether Notion is configured for skill-forge. Returns the current status " +
      "and the CLI command to run if setup is needed. Does not expose secrets.",
    inputSchema: {},
  },
  async () => {
    const token = process.env.NOTION_TOKEN;
    const dbId = process.env.NOTION_DATABASE_ID;

    if (token && dbId) {
      // Mask the token — show only last 4 chars
      const masked = `ntn_…${token.slice(-4)}`;
      return {
        content: [
          {
            type: "text",
            text: [
              "✓ Notion is configured.",
              `  Token:    ${masked}`,
              `  Database: ${dbId}`,
              "",
              "Use share_last_artifact with destination: notion to push an artifact.",
            ].join("\n"),
          },
        ],
      };
    }

    const missing = [
      !token ? "NOTION_TOKEN" : null,
      !dbId ? "NOTION_DATABASE_ID" : null,
    ]
      .filter(Boolean)
      .join(", ");

    return {
      content: [
        {
          type: "text",
          text: [
            `✗ Notion is not configured (missing: ${missing}).`,
            "",
            "Run this in a terminal to complete setup:",
            "  skill-forge auth notion",
            "",
            "Or follow the manual steps in the README under 'Connect to Notion'.",
          ].join("\n"),
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("skill-forge MCP server failed to start:", err);
  process.exit(1);
});
