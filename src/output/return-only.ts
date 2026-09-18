import { TranslatorOutput, SessionSummary } from "../types/session.js";
import { renderMarkdown } from "./renderer.js";

/** Connector name that switches the tool layer into host-delivery mode. */
export const RETURN_ONLY = "return_only";

/**
 * Host-delivery output (plan_ahead.md Bet 2). The artifact is still written to the
 * local corpus (so `index.yml` and the typed bank stay intact); on top of that we
 * hand the *fully rendered* markdown (frontmatter + body) back to the caller with a
 * destination-agnostic instruction. The host then delivers it using a connector the
 * user has already authorized — e.g. a NotebookLM/Gemini-Notebook MCP's
 * `add_source(type=text)`, a Slack post, a LinkedIn draft, or a Google Doc — so
 * skill-forge never holds those credentials.
 */
export function formatReturnOnly(
  output: TranslatorOutput,
  session: SessionSummary,
  localPath: string
): string {
  const rendered = renderMarkdown(output, session);
  return [
    `### ${output.mode}`,
    `Saved to local corpus: ${localPath}`,
    "",
    "**Deliver this artifact** to the user's chosen destination (e.g. Slack, LinkedIn, " +
      "Google Docs, or a NotebookLM/Gemini-Notebook source) using a connector the host " +
      "already has authorized. Pass the markdown below verbatim — for a notebook source, " +
      "add it as a text source. The full rendered artifact:",
    "",
    rendered,
  ].join("\n");
}
