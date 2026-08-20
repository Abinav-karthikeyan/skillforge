import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  instances: [] as any[],
  pageId: "page-123",
  pageUrl: "https://www.notion.so/page123",
}));

vi.mock("@notionhq/client", () => {
  class MockClient {
    pages = {
      create: vi.fn().mockResolvedValue({ id: mocks.pageId, url: mocks.pageUrl }),
    };
    blocks = {
      children: { append: vi.fn().mockResolvedValue({}) },
    };
    constructor() {
      mocks.instances.push(this);
    }
  }
  return { Client: MockClient };
});

import { NotionConnector } from "../../src/output/connectors/notion.js";
import { SessionSummary, TranslatorOutput } from "../../src/types/session.js";

function makeSession(): SessionSummary {
  return {
    session_id: "sess-001",
    timestamp: "2026-06-12T10:00:00.000Z",
    source_tool: "claude-code",
    summary: {
      one_liner: "Built a Redis-backed rate limiter",
      problem_statement: "p",
      approach: "a",
      tradeoffs: [],
      dead_ends: [],
      technologies: ["Redis", "Express"],
      patterns_used: ["Middleware pattern"],
    },
  };
}

function makeOutput(): TranslatorOutput {
  return {
    mode: "portfolio-bullet",
    session_id: "sess-001",
    timestamp: "2026-06-12T10:00:00.000Z",
    content: "- Accomplished X by doing Y.",
    prompt_version: "portfolio-bullet@v1",
  };
}

function getClient() {
  return mocks.instances[mocks.instances.length - 1] as {
    pages: { create: ReturnType<typeof vi.fn> };
    blocks: { children: { append: ReturnType<typeof vi.fn> } };
  };
}

beforeEach(() => {
  mocks.instances.length = 0;
});

describe("NotionConnector", () => {
  it("creates a page with canonical properties", async () => {
    const connector = new NotionConnector({ token: "ntn_test", databaseId: "db-1" });
    const url = await connector.write(makeOutput(), makeSession());

    const client = getClient();
    const call = client.pages.create.mock.calls[0][0];

    expect(url).toBe(mocks.pageUrl);
    expect(call.parent).toEqual({ database_id: "db-1" });
    expect(call.properties.Title.title[0].text.content).toBe("Built a Redis-backed rate limiter");
    expect(call.properties.Mode.select.name).toBe("portfolio-bullet");
    expect(call.properties.Date.date.start).toBe("2026-06-12");
    expect(call.properties["One-liner"].rich_text[0].text.content).toBe("Built a Redis-backed rate limiter");
    expect(call.properties.Technologies.multi_select.map((t: { name: string }) => t.name)).toEqual([
      "Redis",
      "Express",
    ]);
    expect(call.properties.Patterns.multi_select.map((t: { name: string }) => t.name)).toEqual([
      "Middleware pattern",
    ]);
    expect(call.properties["Prompt Version"].rich_text[0].text.content).toBe("portfolio-bullet@v1");
  });

  it("maps canonical properties to custom database column names", async () => {
    const connector = new NotionConnector({
      token: "ntn_test",
      databaseId: "db-1",
      propertyMap: { Title: "Story", Mode: "Type", "One-liner": "Summary" },
    });
    await connector.write(makeOutput(), makeSession());

    const call = getClient().pages.create.mock.calls[0][0];
    expect(call.properties.Story.title[0].text.content).toBe("Built a Redis-backed rate limiter");
    expect(call.properties.Type.select.name).toBe("portfolio-bullet");
    expect(call.properties.Summary.rich_text[0].text.content).toBe("Built a Redis-backed rate limiter");
  });

  it("omits Prompt Version property when the output has none", async () => {
    const connector = new NotionConnector({ token: "ntn_test", databaseId: "db-1" });
    await connector.write(
      { ...makeOutput(), prompt_version: undefined },
      makeSession()
    );

    const call = getClient().pages.create.mock.calls[0][0];
    expect(call.properties["Prompt Version"]).toBeUndefined();
  });

  it("appends additional block chunks beyond the first 100", async () => {
    const longMd = Array.from({ length: 120 }, (_, i) => `${i + 1}. item ${i}`).join("\n");
    const connector = new NotionConnector({ token: "ntn_test", databaseId: "db-1" });

    await connector.writePreRendered(longMd, {
      oneLiner: "One liner",
      mode: "portfolio-bullet",
      date: "2026-06-12",
      technologies: [],
      patterns: [],
    });

    const client = getClient();
    expect(client.pages.create.mock.calls[0][0].children).toHaveLength(100);
    expect(client.blocks.children.append).toHaveBeenCalledTimes(1);
    expect(client.blocks.children.append.mock.calls[0][0].children).toHaveLength(20);
  });
});
