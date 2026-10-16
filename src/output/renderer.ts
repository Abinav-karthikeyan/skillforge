import { TranslatorOutput, SessionSummary } from "../types/session.js";

const MODE_TITLES: Record<string, string> = {
  "interview-qa": "Interview Q&A",
  "portfolio-bullet": "Portfolio Bullets",
  "technical-deep-dive": "Technical Deep-Dive",
};

function buildFrontmatter(output: TranslatorOutput, session: SessionSummary): string {
  const techs = session.summary.technologies.map((t) => `"${t}"`).join(", ");
  const oneLiner = session.summary.one_liner.replace(/"/g, '\\"');

  const lines = [
    "---",
    `session_id: ${session.session_id}`,
    `mode: ${output.mode}`,
    `timestamp: ${output.timestamp}`,
    `source_tool: ${session.source_tool}`,
    `one_liner: "${oneLiner}"`,
    `technologies: [${techs}]`,
  ];

  if (output.prompt_version) {
    lines.push(`prompt_version: ${output.prompt_version}`);
  }

  // v3 living-artifact fields — emitted only when present, so a story-less
  // artifact renders exactly as it did in v2. JSON strings are valid YAML
  // double-quoted scalars, which keeps user-supplied story ids safe.
  if (session.story_id) {
    lines.push(`story_id: ${JSON.stringify(session.story_id)}`);
  }
  if (output.artifact_version !== undefined) {
    lines.push(`version: ${output.artifact_version}`);
  }
  const evidenceIds = (session.summary.evidence ?? []).map((e) => JSON.stringify(e.id));
  if (evidenceIds.length > 0) {
    lines.push(`evidence_ids: [${evidenceIds.join(", ")}]`);
  }

  lines.push("---", "");
  return lines.join("\n");
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
