/**
 * Interactive Notion authentication flow for `career-mode auth notion`.
 *
 * Style: gh auth login — one linear prompt sequence, masked token input,
 * live API validation at each step, atomic writes at the end.
 *
 * Flow:
 *   1. Check existing auth → offer to re-authenticate
 *   2. Prompt for integration token (masked, never logged)
 *   3. Validate token → show integration name
 *   4. Search for pages the integration can see → let user pick, or paste a URL
 *   5. Create the Career Mode Artifacts database via raw fetch
 *   6. Write NOTION_TOKEN + NOTION_DATABASE_ID to ~/.career-mode/.env
 *   7. Write connector settings to ~/.career-mode/config.yaml
 *   8. Print confirmation and next command
 */

import { createInterface } from "readline";
import { writeEnvSecrets, writeConfigYaml } from "./config-writer.js";

const NOTION_VERSION = "2022-06-28";

// ── Low-level prompt helpers ─────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);

    if ((process.stdin as NodeJS.ReadStream).isTTY) {
      (process.stdin as NodeJS.ReadStream).setRawMode(true);
    }
    process.stdin.resume();

    let answer = "";

    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 13 || byte === 10) {
          // Enter
          process.stdout.write("\n");
          cleanup();
          resolve(answer);
          return;
        } else if (byte === 3) {
          // Ctrl-C
          process.stdout.write("\n");
          cleanup();
          reject(new Error("Interrupted"));
          return;
        } else if (byte === 4) {
          // Ctrl-D (EOF)
          process.stdout.write("\n");
          cleanup();
          resolve(answer);
          return;
        } else if (byte === 127 || byte === 8) {
          // Backspace
          if (answer.length > 0) answer = answer.slice(0, -1);
        } else if (byte >= 32) {
          answer += String.fromCharCode(byte);
        }
      }
    };

    const cleanup = () => {
      if ((process.stdin as NodeJS.ReadStream).isTTY) {
        (process.stdin as NodeJS.ReadStream).setRawMode(false);
      }
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };

    process.stdin.on("data", onData);
  });
}

// ── Notion API helpers ───────────────────────────────────────────────────────

interface NotionPage {
  id: string;
  title: string;
}

async function validateToken(token: string): Promise<string> {
  const res = await fetch("https://api.notion.com/v1/users/me", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
    },
  });
  if (!res.ok) {
    const body: any = await res.json();
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }
  const user: any = await res.json();
  return user.bot?.owner?.workspace_name ?? user.name ?? "your workspace";
}

async function searchAccessiblePages(token: string): Promise<NotionPage[]> {
  const res = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify({
      filter: { property: "object", value: "page" },
      page_size: 20,
    }),
  });
  if (!res.ok) return [];
  const data: any = await res.json();
  return (data.results ?? []).map((p: any) => ({
    id: p.id,
    title:
      p.child_page?.title ??
      p.properties?.title?.title?.[0]?.plain_text ??
      p.properties?.Name?.title?.[0]?.plain_text ??
      "(untitled)",
  }));
}

async function createDatabase(token: string, parentPageId: string): Promise<{ id: string; url: string }> {
  const res = await fetch("https://api.notion.com/v1/databases", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // Raw fetch required — @notionhq/client v5 strips `properties` from
      // the createDatabase bodyParams, producing an empty-schema database.
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify({
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: "Career Mode Artifacts" } }],
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
    if (db.code === "object_not_found") {
      throw new Error(
        "Notion cannot find that page. Make sure you shared it with your integration:\n" +
          "  1. Open the page in Notion\n" +
          "  2. Click ··· → Connections → add your integration"
      );
    }
    throw new Error(db.message ?? `HTTP ${res.status}`);
  }
  return { id: db.id, url: db.url };
}

// ── Extract hex page ID from a Notion URL or raw ID ─────────────────────────

function extractPageId(raw: string): string | null {
  const match = raw.match(
    /([0-9a-f]{32})$|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  return match ? (match[1] ?? match[2]) : null;
}

// ── Main flow ────────────────────────────────────────────────────────────────

export async function authNotion(): Promise<void> {
  console.log("\nConnecting Career Mode to Notion");
  console.log("─".repeat(40));

  // 1. Check existing auth
  const existingToken = process.env.NOTION_TOKEN;
  const existingDbId = process.env.NOTION_DATABASE_ID;
  if (existingToken && existingDbId) {
    console.log(`\nAlready authenticated (database: ${existingDbId.slice(0, 8)}…)`);
    const again = await prompt("Re-authenticate? [y/N] ");
    if (!again.toLowerCase().startsWith("y")) {
      console.log("Keeping existing configuration.");
      return;
    }
  }

  // 2. Prompt for token (masked)
  console.log("\nCreate an integration at https://www.notion.so/profile/integrations");
  console.log("then paste the Internal Integration Secret below.\n");
  const token = await promptSecret("Integration token (hidden): ");

  if (!token) {
    console.error("No token provided. Aborted.");
    process.exit(1);
  }

  // 3. Validate token
  process.stdout.write("Validating token… ");
  let workspaceName: string;
  try {
    workspaceName = await validateToken(token);
    console.log(`✓ Connected to "${workspaceName}"`);
  } catch (err: any) {
    console.error("\n✗ Invalid token:", err.message);
    process.exit(1);
  }

  // 4. Pick a parent page
  let parentPageId: string;

  process.stdout.write("Searching for accessible pages… ");
  const pages = await searchAccessiblePages(token);

  if (pages.length === 0) {
    console.log("none found.\n");
    console.log("Share at least one page with your integration first:");
    console.log("  1. Open a Notion page");
    console.log("  2. Click ··· → Connections → add your integration");
    console.log('\nThen re-run: career-mode auth notion\n');
    process.exit(0);
  }

  console.log(`found ${pages.length} page(s).\n`);
  pages.forEach((p, i) => console.log(`  [${i + 1}] ${p.title}  (${p.id.slice(0, 8)}…)`));
  console.log(`  [0] Enter a page URL or ID manually`);
  console.log();

  const choice = await prompt("Pick a parent page [1]: ");
  const idx = parseInt(choice || "1", 10);

  if (idx === 0 || isNaN(idx)) {
    const raw = await prompt("Page URL or ID: ");
    const extracted = extractPageId(raw);
    if (!extracted) {
      console.error("Could not extract a valid page ID from that input. Aborted.");
      process.exit(1);
    }
    parentPageId = extracted;
  } else if (idx >= 1 && idx <= pages.length) {
    parentPageId = pages[idx - 1].id;
  } else {
    console.error(`Invalid choice. Enter a number between 0 and ${pages.length}.`);
    process.exit(1);
  }

  // 5. Create the database
  process.stdout.write(`Creating "Career Mode Artifacts" database… `);
  let db: { id: string; url: string };
  try {
    db = await createDatabase(token, parentPageId);
    console.log("✓");
  } catch (err: any) {
    console.error("\n✗ Failed to create database:\n" + err.message);
    process.exit(1);
  }

  // 6 & 7. Write secrets and config (never log the full token)
  writeEnvSecrets({
    NOTION_TOKEN: token,
    NOTION_DATABASE_ID: db.id,
  });

  writeConfigYaml({
    connector: "notion",
    notion_token: "${NOTION_TOKEN}",
    notion_database_id: "${NOTION_DATABASE_ID}",
  });

  // 8. Confirmation
  const maskedToken = `ntn_…${token.slice(-4)}`;
  console.log(`\n✓ Authenticated as ${workspaceName}`);
  console.log(`  Token:    ${maskedToken}  → ~/.career-mode/.env`);
  console.log(`  Database: ${db.id}`);
  console.log(`  URL:      ${db.url}`);
  console.log(`\nArtifacts will now sync to Notion. Try it:`);
  console.log(`  career-mode generate --mode portfolio-bullet`);
}
