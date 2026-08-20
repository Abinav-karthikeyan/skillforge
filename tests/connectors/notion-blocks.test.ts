import { describe, expect, it } from "vitest";
import { chunkBlocks, markdownToNotionBlocks } from "../../src/output/connectors/notion-blocks.js";

describe("markdownToNotionBlocks", () => {
  it("strips YAML frontmatter", () => {
    const md = "---\nsession_id: x\nmode: y\n---\n\n# Title\n";
    const blocks = markdownToNotionBlocks(md);
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toMatchObject({ type: "heading_1" });
  });

  it("maps headings, bullets, numbered lists, quotes, code and dividers", () => {
    const md = [
      "# H1",
      "## H2",
      "### H3",
      "> A quote",
      "- bullet one",
      "- bullet two",
      "1. first",
      "2. second",
      "```ts",
      "const x = 1;",
      "```",
      "---",
      "plain paragraph",
    ].join("\n");

    const types = markdownToNotionBlocks(md).map((b) => b.type);
    expect(types).toEqual([
      "heading_1",
      "heading_2",
      "heading_3",
      "quote",
      "bulleted_list_item",
      "bulleted_list_item",
      "numbered_list_item",
      "numbered_list_item",
      "code",
      "divider",
      "paragraph",
    ]);
  });

  it("groups consecutive quote lines into a single quote block", () => {
    const blocks = markdownToNotionBlocks("> line one\n> line two");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("quote");
    expect((blocks[0].quote as { rich_text: { text: { content: string } }[] }).rich_text[0].text.content).toBe(
      "line one\nline two"
    );
  });

  it("captures the code language", () => {
    const blocks = markdownToNotionBlocks("```typescript\nconst x = 1;\n```");
    expect(blocks[0].type).toBe("code");
    expect((blocks[0].code as { language: string }).language).toBe("typescript");
    expect((blocks[0].code as { rich_text: { text: { content: string } }[] }).rich_text[0].text.content).toBe(
      "const x = 1;"
    );
  });

  it("chunks long text into 2000-char rich_text segments", () => {
    const longLine = "x".repeat(4500);
    const blocks = markdownToNotionBlocks(`# Title\n\n${longLine}`);

    const paragraph = blocks.find((b) => b.type === "paragraph") as unknown as {
      paragraph: { rich_text: { text: { content: string } }[] };
    };
    expect(paragraph.paragraph.rich_text).toHaveLength(3);
    expect(paragraph.paragraph.rich_text[0].text.content).toHaveLength(2000);
  });

  it("ignores blank lines", () => {
    const blocks = markdownToNotionBlocks("\n\n\nHello\n\n\n");
    expect(blocks).toHaveLength(1);
  });
});

describe("chunkBlocks", () => {
  it("splits more than 100 blocks into 100-block chunks", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [] } }));
    const chunks = chunkBlocks(many as never);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(100);
    expect(chunks[1]).toHaveLength(100);
    expect(chunks[2]).toHaveLength(50);
  });

  it("returns a single empty chunk for no blocks", () => {
    expect(chunkBlocks([])).toEqual([[]]);
  });
});
