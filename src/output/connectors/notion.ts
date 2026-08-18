import { Client } from "@notionhq/client";
import { TranslatorOutput, SessionSummary } from "../../types/session.js";
import { renderMarkdown } from "../renderer.js";
import { CareerModeConnector } from "./types.js";
import { markdownToNotionBlocks, chunkBlocks } from "./notion-blocks.js";
import { registerConnector } from "./registry.js";

export interface NotionConnectorOptions {
  token?: string;
  databaseId?: string;
  propertyMap?: Record<string, string>;
}

export class NotionConnector implements CareerModeConnector {
  private client: Client;
  private databaseId: string;
  private propertyMap: Record<string, string>;

  constructor(opts: NotionConnectorOptions = {}) {
    const token = opts.token ?? process.env.NOTION_TOKEN;
    if (!token) {
      throw new Error(
        "NotionConnector requires a Notion integration token. Set NOTION_TOKEN in the environment " +
          "or set `notion_token` in career-mode.config.yaml. " +
          "Create an integration at https://www.notion.so/profile/integrations"
      );
    }
    if (!opts.databaseId) {
      throw new Error(
        "NotionConnector requires a database ID. Set `notion_database_id` in career-mode.config.yaml. " +
          "Run `npx tsx scripts/notion-setup.ts` to create the database automatically."
      );
    }
    this.client = new Client({ auth: token });
    this.databaseId = opts.databaseId;
    this.propertyMap = opts.propertyMap ?? {};
  }

  private prop(canonical: string): string {
    return this.propertyMap[canonical] ?? canonical;
  }

  async write(output: TranslatorOutput, session: SessionSummary): Promise<string> {
    const markdown = renderMarkdown(output, session);
    return this.createPage(markdown, {
      oneLiner: session.summary.one_liner,
      mode: output.mode,
      date: output.timestamp.slice(0, 10),
      technologies: session.summary.technologies,
      patterns: session.summary.patterns_used,
      promptVersion: output.prompt_version,
    });
  }

  async writePreRendered(markdown: string, meta: {
    oneLiner: string;
    mode: string;
    date: string;
    technologies: string[];
    patterns: string[];
    promptVersion?: string;
  }): Promise<string> {
    return this.createPage(markdown, meta);
  }

  private async createPage(markdown: string, meta: {
    oneLiner: string;
    mode: string;
    date: string;
    technologies: string[];
    patterns: string[];
    promptVersion?: string;
  }): Promise<string> {
    const blocks = markdownToNotionBlocks(markdown);
    const chunks = chunkBlocks(blocks);

    const page = await this.client.pages.create({
      parent: { database_id: this.databaseId },
      properties: {
        [this.prop("Title")]: {
          title: [{ type: "text" as const, text: { content: meta.oneLiner } }],
        },
        [this.prop("Mode")]: {
          select: { name: meta.mode },
        },
        [this.prop("Date")]: {
          date: { start: meta.date },
        },
        [this.prop("One-liner")]: {
          rich_text: [{ type: "text" as const, text: { content: meta.oneLiner } }],
        },
        [this.prop("Technologies")]: {
          multi_select: meta.technologies.map((t) => ({ name: t })),
        },
        [this.prop("Patterns")]: {
          multi_select: meta.patterns.map((p) => ({ name: p })),
        },
        ...(meta.promptVersion
          ? {
              [this.prop("Prompt Version")]: {
                rich_text: [{ type: "text" as const, text: { content: meta.promptVersion } }],
              },
            }
          : {}),
      },
      children: chunks[0] as any[],
    });

    for (let i = 1; i < chunks.length; i++) {
      await this.client.blocks.children.append({
        block_id: page.id,
        children: chunks[i] as any[],
      });
    }

    const pageUrl = (page as any).url as string;
    return pageUrl ?? `https://notion.so/${page.id.replace(/-/g, "")}`;
  }
}

registerConnector({
  name: "notion",
  secretFields: ["notion_token"],
  alwaysWriteLocal: true,
  create(config) {
    return new NotionConnector({
      token: config.notion_token,
      databaseId: config.notion_database_id,
      propertyMap: config.notion_property_map,
    });
  },
});
