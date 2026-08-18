type RichText = { type: "text"; text: { content: string } };
type NotionBlock = { object: "block"; type: string; [key: string]: unknown };

const RICH_TEXT_LIMIT = 2000;

function richText(content: string): RichText[] {
  const chunks: RichText[] = [];
  for (let i = 0; i < content.length; i += RICH_TEXT_LIMIT) {
    chunks.push({ type: "text", text: { content: content.slice(i, i + RICH_TEXT_LIMIT) } });
  }
  return chunks.length > 0 ? chunks : [{ type: "text", text: { content: "" } }];
}

function heading(level: 1 | 2 | 3, text: string): NotionBlock {
  const key = `heading_${level}` as const;
  return { object: "block", type: key, [key]: { rich_text: richText(text) } };
}

function paragraph(text: string): NotionBlock {
  return { object: "block", type: "paragraph", paragraph: { rich_text: richText(text) } };
}

function bulletItem(text: string): NotionBlock {
  return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: richText(text) } };
}

function numberedItem(text: string): NotionBlock {
  return { object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: richText(text) } };
}

function codeBlock(code: string, language: string): NotionBlock {
  return {
    object: "block",
    type: "code",
    code: { rich_text: richText(code), language: language || "plain text" },
  };
}

function quote(text: string): NotionBlock {
  return { object: "block", type: "quote", quote: { rich_text: richText(text) } };
}

function divider(): NotionBlock {
  return { object: "block", type: "divider", divider: {} };
}

export function markdownToNotionBlocks(md: string): NotionBlock[] {
  const fmStripped = md.replace(/^---\n[\s\S]*?\n---\n*/, "");
  const lines = fmStripped.split("\n");
  const blocks: NotionBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push(codeBlock(codeLines.join("\n"), lang));
      i++;
      continue;
    }

    if (/^### /.test(line)) {
      blocks.push(heading(3, line.slice(4)));
      i++;
      continue;
    }
    if (/^## /.test(line)) {
      blocks.push(heading(2, line.slice(3)));
      i++;
      continue;
    }
    if (/^# /.test(line)) {
      blocks.push(heading(1, line.slice(2)));
      i++;
      continue;
    }

    if (/^---\s*$/.test(line)) {
      blocks.push(divider());
      i++;
      continue;
    }

    if (/^> /.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^> /.test(lines[i])) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      blocks.push(quote(quoteLines.join("\n")));
      continue;
    }

    if (/^\d+\.\s/.test(line)) {
      blocks.push(numberedItem(line.replace(/^\d+\.\s/, "")));
      i++;
      continue;
    }

    if (/^[-*]\s/.test(line)) {
      blocks.push(bulletItem(line.replace(/^[-*]\s/, "")));
      i++;
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    blocks.push(paragraph(line));
    i++;
  }

  return blocks;
}

const BLOCKS_PER_REQUEST = 100;

export function chunkBlocks(blocks: NotionBlock[]): NotionBlock[][] {
  const chunks: NotionBlock[][] = [];
  for (let i = 0; i < blocks.length; i += BLOCKS_PER_REQUEST) {
    chunks.push(blocks.slice(i, i + BLOCKS_PER_REQUEST));
  }
  return chunks.length > 0 ? chunks : [[]];
}
