# skill-forge MCP server

skill-forge also ships as a standalone MCP (Model Context Protocol) server. Where the `/skill-forge` slash command is Claude-Code-specific (a skill file that shells out to the CLI), the MCP server exposes the same pipeline as two typed tools over stdio — usable by any MCP-capable client (Claude Code, Claude Desktop, or any other MCP host).

## Why a third path, when the CLI and slash command already work?

- **The slash command is a prompt, not a protocol.** It's a `.md` file that instructs Claude to shell out to `npx tsx src/index.ts`. That's Claude-Code-only and brittle to how the host chooses to interpret the instructions.
- **The MCP server is a typed contract.** Tool names, input schemas (Zod), and output shape are explicit and machine-checked. Any MCP host can discover and call `generate_skill_forge_artifact` without knowing anything about this repo's CLI flags.
- **It's the same core.** Both the CLI and the MCP server call the same `ingestSession` → translator → `LocalFileConnector` pipeline. The MCP server is a thin transport wrapper (`src/mcp/server.ts`), not a reimplementation.

Use the CLI for scripting and CI. Use the slash command if you're only ever in Claude Code and want the lowest-friction invocation. Use the MCP server if you want skill-forge available as a tool across MCP hosts, or you're building on top of it programmatically.

## Tools exposed

### `generate_skill_forge_artifact`

| Input | Type | Notes |
|---|---|---|
| `mode` | `"interview-qa" \| "portfolio-bullet" \| "technical-deep-dive" \| "all"` | Default `portfolio-bullet` |
| `session_summary` | object (optional) | Structured session context — `summary.one_liner`, `problem_statement`, `approach`, `tradeoffs`, `dead_ends`, `technologies`, `patterns_used`, `complexity_signals`. Omit to fall back to summarizing local `git log`/`git diff`. |
| `output_dir` | string (optional) | Overrides the configured output directory. |
| `connector` | string (optional) | `local` (default), `gist`, `notion`, or `return_only`. See host-delivery below. |

Returns the rendered markdown for each generated mode plus the file path it was written to.

#### Host-delivery mode (`connector: "return_only"`)

Set `connector` to `return_only` to make skill-forge **write the artifact to the local
corpus** (so `index.yml` and the typed bank stay intact) **and return the fully rendered
markdown to the caller** with a destination-agnostic delivery instruction — instead of
pushing anywhere itself. The *host* then delivers it using a connector the user has already
authorized, so skill-forge never holds those credentials.

This is the plan's connector strategy (`plan_ahead.md` Bet 2): zero credentials to maintain,
and it gets better every time a host adds a connector — with no skill-forge release. Example
targets: a Slack post, a LinkedIn draft, a Google Doc, or a **NotebookLM / Gemini-Notebook**
MCP's `add_source(type=text)` — the returned markdown is passed verbatim as a text source.

### `list_skill_forge_artifacts`

| Input | Type | Notes |
|---|---|---|
| `output_dir` | string (optional) | Overrides the configured output directory. |

Returns the contents of `index.yml` for the resolved output directory.

### `share_last_artifact`

| Input | Type | Notes |
|---|---|---|
| `output_dir` | string (optional) | Overrides the configured artifacts directory. |
| `is_public` | boolean (optional) | Create a public gist. Defaults to secret (unlisted). |

Reads the most recently generated artifact from `index.yml`, uploads it to a GitHub Gist via the Gist API, and returns the shareable URL. Requires `GITHUB_TOKEN` in the environment or `gist_token` in `skill-forge.config.yaml` (needs the `gist` scope, nothing else).

Typical flow in an MCP host: after `generate_skill_forge_artifact` writes a portfolio bullet, ask the host to "share the last artifact" — the URL comes back inline and you can drop it into a resume or a message.

## Running it

```bash
npm install
npx tsx src/mcp/server.ts
```

Or after `npm run build`:

```bash
node dist/mcp/server.js
```

It speaks MCP over stdio — it isn't meant to be run standalone in a terminal for interactive use; an MCP host launches it as a subprocess.

## Registering with Claude Code

Project-scoped (`.mcp.json` in the project root) or via the CLI:

```bash
claude mcp add skill-forge -- npx tsx /absolute/path/to/careermode-mcp/src/mcp/server.ts
```

Or add directly to `.mcp.json`:

```json
{
  "mcpServers": {
    "skill-forge": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/careermode-mcp/src/mcp/server.ts"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

A copy of this config lives at `claude-code-integration/mcp/.mcp.json` — copy it in and fill in the absolute path and key.

After registering, restart Claude Code. Ask it to "generate a portfolio bullet for what we just built" and it will call `generate_skill_forge_artifact` with a `session_summary` synthesized from the conversation — the same rich context the slash command captures, just delivered through a typed tool call instead of a shell-out.

## Provider configuration

Same as the CLI — the server reads `skill-forge.config.yaml` (project root, then `~/.skill-forge/config.yaml`) and falls back to auto-detecting a provider from environment variables (`ANTHROPIC_API_KEY` → Anthropic, `OPENAI_API_KEY` → OpenAI, neither → Ollama at `localhost:11434`). See the main [README](../README.md#configuration) for the full config reference.

## Status

Implemented, typechecked, and verified two ways:
- `scripts/mcp-smoke-test.ts` spawns the built server and drives it through the MCP client SDK: `initialize` → `tools/list` → `list_skill_forge_artifacts` → a real `generate_skill_forge_artifact` call.
- Registered with Claude Code directly (`claude mcp add skill-forge -- node dist/mcp/server.js`); `claude mcp get skill-forge` reports `✔ Connected`.

One build gotcha this surfaced: `tsc` doesn't copy `src/prompts/*.txt` into `dist/` on its own — the `build` script now does that explicitly (`npm run build`). If you see `ENOENT ... dist/prompts/*.txt`, rebuild.

See the root [README](../README.md#status) for the full status list across all three interfaces.
