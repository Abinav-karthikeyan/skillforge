import { TranslatorOutput, SessionSummary } from "../../types/session.js";
import { renderMarkdown } from "../renderer.js";
import { CareerModeConnector } from "./types.js";

export interface GistConnectorOptions {
  token?: string;
  isPublic?: boolean;
}

const GIST_API = "https://api.github.com/gists";

function buildFilename(output: TranslatorOutput, session: SessionSummary): string {
  const date = output.timestamp.slice(0, 10);
  const slug = session.summary.one_liner
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `${date}-${output.mode}-${slug}.md`;
}

export class GistConnector implements CareerModeConnector {
  private token: string;
  private isPublic: boolean;

  constructor(opts: GistConnectorOptions = {}) {
    const token = opts.token ?? process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error(
        "GistConnector requires a GitHub token. Set GITHUB_TOKEN in the environment " +
          "or set `gist_token` in career-mode.config.yaml. The token needs the `gist` scope only."
      );
    }
    this.token = token;
    this.isPublic = opts.isPublic ?? false;
  }

  async write(output: TranslatorOutput, session: SessionSummary): Promise<string> {
    const filename = buildFilename(output, session);
    const markdown = renderMarkdown(output, session);
    const description = `Career Mode — ${output.mode} — ${session.summary.one_liner}`;
    return this.createGist(filename, markdown, description);
  }

  /** Public helper for `share_last_artifact`: push arbitrary already-rendered markdown. */
  async createGist(filename: string, content: string, description: string): Promise<string> {
    const res = await fetch(GIST_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "career-mode",
      },
      body: JSON.stringify({
        description,
        public: this.isPublic,
        files: { [filename]: { content } },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      throw new Error(`GitHub Gist API returned ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as { html_url?: string };
    if (!data.html_url) throw new Error("Gist API response missing html_url");
    return data.html_url;
  }
}
