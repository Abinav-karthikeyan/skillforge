import { afterEach, describe, expect, it, vi } from "vitest";
import { GistConnector } from "../../src/output/connectors/gist.js";
import { SessionSummary, TranslatorOutput } from "../../src/types/session.js";

function mockFetchOk(htmlUrl: string) {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ html_url: htmlUrl }),
    json: async () => ({ html_url: htmlUrl }),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function mockFetchError(status: number, body: string) {
  const fn = vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => body,
    json: async () => ({ message: body }),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

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
      technologies: ["Redis"],
      patterns_used: [],
    },
  };
}

function makeOutput(): TranslatorOutput {
  return {
    mode: "portfolio-bullet",
    session_id: "sess-001",
    timestamp: "2026-06-12T10:00:00.000Z",
    content: "- Accomplished X by doing Y.",
  };
}

describe("GistConnector.createGist", () => {
  it("POSTs the expected payload shape to the Gist API", async () => {
    const fetchMock = mockFetchOk("https://gist.github.com/abc123");
    const gist = new GistConnector({ token: "ghp_test", isPublic: true });

    const url = await gist.createGist("file.md", "# content", "A description");

    expect(url).toBe("https://gist.github.com/abc123");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [endpoint, options] = fetchMock.mock.calls[0] as [string, any];
    expect(endpoint).toBe("https://api.github.com/gists");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer ghp_test");
    expect(options.headers.Accept).toContain("github");

    const body = JSON.parse(options.body);
    expect(body.description).toBe("A description");
    expect(body.public).toBe(true);
    expect(body.files["file.md"].content).toBe("# content");
  });

  it("defaults to a secret gist when isPublic is unset", async () => {
    const fetchMock = mockFetchOk("https://gist.github.com/def456");
    const gist = new GistConnector({ token: "ghp_test" });

    await gist.createGist("file.md", "content", "desc");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.public).toBe(false);
  });

  it("throws with the API status on failure", async () => {
    mockFetchError(401, "Bad credentials");
    const gist = new GistConnector({ token: "ghp_test" });

    await expect(gist.createGist("file.md", "content", "desc")).rejects.toThrow(/401/);
  });
});

describe("GistConnector.write", () => {
  it("renders markdown and builds a dated, slugged filename", async () => {
    const fetchMock = mockFetchOk("https://gist.github.com/xyz");
    const gist = new GistConnector({ token: "ghp_test" });

    const url = await gist.write(makeOutput(), makeSession());

    expect(url).toBe("https://gist.github.com/xyz");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const filename = Object.keys(body.files)[0];
    expect(filename).toMatch(/^2026-06-12-portfolio-bullet-built-a-redis-backed-rate-limiter\.md$/);
    expect(body.files[filename].content).toContain("session_id: sess-001");
    expect(body.description).toContain("portfolio-bullet");
  });
});
