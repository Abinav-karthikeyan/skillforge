import { TranslatorOutput, SessionSummary } from "../types/session.js";

const MODE_TITLES: Record<string, string> = {
  "interview-qa": "Interview Q&A",
  "portfolio-bullet": "Portfolio Bullets",
  "technical-deep-dive": "Technical Deep-Dive",
};

function buildFrontmatter(output: TranslatorOutput, session: SessionSummary): string {
  const techs = session.summary.technologies.map((t) => `"${t}"`).join(", ");
  const oneLiner = session.summary.one_liner.replace(/"/g, '\\"');

  return [
    "---",
    `session_id: ${session.session_id}`,
    `mode: ${output.mode}`,
    `timestamp: ${output.timestamp}`,
    `source_tool: ${session.source_tool}`,
    `one_liner: "${oneLiner}"`,
    `technologies: [${techs}]`,
    "---",
    "",
  ].join("\n");
}

function buildHeader(output: TranslatorOutput, session: SessionSummary): string {
  const title = MODE_TITLES[output.mode] ?? output.mode;
  const date = output.timestamp.slice(0, 10);

  return [
    `# ${title}`,
    "",
    `> ${session.summary.one_liner}`,
    "",
    `**Date:** ${date}  `,
    `**Technologies:** ${session.summary.technologies.join(", ") || "—"}  `,
    `**Source:** ${session.source_tool}`,
    "",
    "---",
    "",
  ].join("\n");
}

export function renderMarkdown(output: TranslatorOutput, session: SessionSummary): string {
  return buildFrontmatter(output, session) + buildHeader(output, session) + output.content;
}
