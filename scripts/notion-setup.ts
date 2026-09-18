#!/usr/bin/env npx tsx
/**
 * Creates a skill-forge database in Notion with the correct schema.
 *
 * Usage:
 *   npx tsx scripts/notion-setup.ts [parent-page-id]
 *
 * NOTION_TOKEN and optionally NOTION_PAGE_ID are read from .env
 * (project root or ~/.skill-forge/.env).
 * The parent page must be shared with your Notion integration.
 * Go to https://www.notion.so/profile/integrations to create one.
 */

import "../src/config/preload-env.js";

const token = process.env.NOTION_TOKEN;
if (!token) {
  console.error("Error: NOTION_TOKEN is not set.");
  console.error("Add NOTION_TOKEN=ntn_... to your .env file (project root or ~/.skill-forge/.env).");
  console.error("Create an integration at https://www.notion.so/profile/integrations");
  process.exit(1);
}

const rawPageId = process.argv[2] ?? process.env.NOTION_PAGE_ID;
const hexMatch = rawPageId?.match(/([0-9a-f]{32})$|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
const parentPageId = hexMatch ? (hexMatch[1] ?? hexMatch[2]) : rawPageId;

if (!parentPageId) {
  console.error("Usage: npx tsx scripts/notion-setup.ts <parent-page-id>");
  console.error("  Or set NOTION_PAGE_ID in your .env file.");
  console.error("");
  console.error("The parent-page-id is the ID of an existing Notion page where the database will be created.");
  console.error("You can find it in the page URL: notion.so/<workspace>/<page-title>-<PAGE_ID>");
  console.error("");
  console.error("Important: The page must be shared with your Notion integration.");
  console.error('  1. Open the page in Notion');
  console.error('  2. Click "..." → "Connections" → Add your integration');
  process.exit(1);
}

async function main() {
  console.log("Creating skill-forge database...");
  console.log(`  Parent page: ${parentPageId}`);

  try {
    // Use raw fetch — @notionhq/client v5 removed `properties` from the
    // createDatabase bodyParams, so both databases.create() and request()
    // may strip or ignore it depending on SDK internals.
    const res = await fetch("https://api.notion.com/v1/databases", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        parent: { type: "page_id", page_id: parentPageId },
        title: [{ type: "text", text: { content: "skill-forge Artifacts" } }],
        properties: {
          Title: { title: {} },
          Mode: {
            select: {
              options: [
                { name: "interview-qa", color: "blue" },
                { name: "portfolio-bullet", color: "green" },
                { name: "technical-deep-dive", color: "purple" },
              ],
            },
          },
          Date: { date: {} },
          "One-liner": { rich_text: {} },
          Technologies: { multi_select: { options: [] } },
          Patterns: { multi_select: { options: [] } },
          "Prompt Version": { rich_text: {} },
        },
      }),
    });
    const db: any = await res.json();
    if (!res.ok) {
      throw { code: db.code, message: db.message };
    }

    console.log("");
    console.log("Database created successfully!");
    console.log("");
    console.log("Add this to your skill-forge.config.yaml:");
    console.log("");
    console.log("  connector: notion");
    console.log(`  notion_token: \${NOTION_TOKEN}`);
    console.log(`  notion_database_id: ${db.id}`);
    console.log("");
    console.log(`Database URL: ${db.url}`);
  } catch (err: any) {
    if (err?.code === "object_not_found") {
      console.error("");
      console.error("Error: Notion could not find the parent page.");
      console.error("This usually means the page isn't shared with your integration.");
      console.error("");
      console.error("Fix:");
      console.error('  1. Open the parent page in Notion');
      console.error('  2. Click "..." (top right) → "Connections"');
      console.error("  3. Add your integration");
      console.error("");
      console.error(`  Page ID provided: ${parentPageId}`);
      process.exit(1);
    }
    console.error("Error:", err?.message ?? err);
    process.exit(1);
  }
}

main();
