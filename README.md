# Career Mode

> Turn your Claude Code sessions into career artifacts — interview answers, resume bullets, and technical deep-dives — while the context is still fresh.

## The problem

You just spent four hours debugging a subtle race condition, designed a provider abstraction that supports five LLM backends, or ripped out legacy auth middleware for compliance reasons. In a week you'll remember "fixed some bug." In six months you'll remember nothing. Resumes and interview answers are reconstructed from memory long after the specifics have faded.

Career Mode captures session context at peak richness — right now, while the conversation is still open — and translates it into artifacts you can actually use.

## How it works

Career Mode is a single pipeline (`ingestor → translators → output`) exposed three ways:

| Interface | When you'd use it | Context source |
|---|---|---|
| **CLI** (`career-mode generate`) | Scripting, CI, or piping a git diff directly | `--json` file, or local git log/diff |
| **`/career-mode` slash command** | End of a Claude Code session, lowest friction | Full conversation transcript — richest |
| **MCP server** (`career-mode-mcp`) | Any MCP-capable host (Claude Code, Claude Desktop, others); programmatic use | Tool call args (`session_summary`), or git fallback |

There's also a `git commit` hook path (git log + diff only, no transcript) — see [Configuration](#4-optional-install-the-git-commit-hook) below.

All interfaces feed the same translation pipeline and write `.md` artifacts to `~/.career-mode/artifacts/`. See [docs/mcp-server.md](docs/mcp-server.md) for the MCP server's tool contract and [docs/slash-command.md](docs/slash-command.md) for the slash command walkthrough.

## Quickstart

### 1. Install

```bash
git clone https://github.com/your-username/careermode-mcp
cd careermode-mcp
npm install
```

### 2. Configure your LLM provider

Copy the sample config to your home directory or project root:

```bash
cp career-mode.config.yaml ~/.career-mode/config.yaml
```

Then edit it. Provider is auto-detected from environment variables if you skip the config:

| Env var set | Provider used |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `OPENAI_API_KEY` | OpenAI |
| Neither | Ollama at `localhost:11434` |

See [Configuration](#configuration) for all options including Groq, LM Studio, and other OpenAI-compatible endpoints.

### 3. Install the slash command

Copy the slash command file to Claude Code's global commands directory:

```bash
# macOS / Linux
cp claude-code-integration/commands/career-mode.md ~/.claude/commands/career-mode.md

# Windows (PowerShell)
Copy-Item claude-code-integration\commands\career-mode.md "$env:USERPROFILE\.claude\commands\career-mode.md"
```

Restart Claude Code. `/career-mode` is now available in any session.

### 4. (Optional) Register the MCP server

Instead of (or alongside) the slash command, register Career Mode as an MCP server so any MCP-capable client can call it as a tool:

```bash
claude mcp add career-mode -- npx tsx /absolute/path/to/careermode-mcp/src/mcp/server.ts
```

Or add it to `.mcp.json` directly — see [claude-code-integration/mcp/.mcp.json](claude-code-integration/mcp/.mcp.json) for a template. Full details, tool schemas, and the reasoning for having both a slash command and an MCP server: [docs/mcp-server.md](docs/mcp-server.md).

### 5. (Optional) Install the git commit hook

Add this to your `~/.claude/settings.json` under `hooks`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "pattern": "git commit",
        "command": "npx tsx /path/to/careermode-mcp/src/index.ts generate --mode portfolio-bullet"
      }
    ]
  }
}
```

## Using the slash command

At the end of a coding session in Claude Code, type:

```
/career-mode
```

Claude will synthesize the session into a structured summary, run it through the translation pipeline, and write an artifact to `~/.career-mode/artifacts/`. The output path is printed in the terminal.

You can specify the output mode:

```
/career-mode --mode interview-qa
/career-mode --mode portfolio-bullet
/career-mode --mode technical-deep-dive
/career-mode --mode all
```

Default is `interview-qa`.

See [docs/slash-command.md](docs/slash-command.md) for a detailed walkthrough.

## Output modes

### `interview-qa`
Generates 2–4 interview questions with full STAR answers (Situation, Task, Action, Result), follow-up questions an interviewer might ask, and a calibration note on how to pitch the answer for your experience level.

### `portfolio-bullet`
Generates 3–5 resume/portfolio bullet points in the XYZ format ("Accomplished X by doing Y, resulting in Z"). Calibrated to your `experience_level` in config.

### `technical-deep-dive`
Generates a technical narrative suitable for a blog post, design doc, or engineering portfolio — covering the problem, approach, tradeoffs, and lessons learned.

### `all`
Runs all three modes and writes separate files for each.

## Configuration

Full reference for `career-mode.config.yaml`:

```yaml
experience_level: senior       # junior | mid | senior | staff
tone: balanced                 # technical | business | balanced
output_dir: ~/.career-mode/artifacts

# Provider — auto-detected from env if omitted
# provider: anthropic
# model: claude-sonnet-4-6

# provider: openai
# model: gpt-4o-mini

# provider: ollama
# model: llama3.2
# base_url: http://localhost:11434/v1

# provider: openai-compatible   # Groq, Together AI, LM Studio, etc.
# model: mixtral-8x7b-32768
# base_url: https://api.groq.com/openai/v1
# api_key: gsk_...

# Optional calibration
# target_role: Staff Engineer
# company_size: startup         # startup | mid | enterprise
# default_mode: portfolio-bullet
```

Place this file at `~/.career-mode/config.yaml` (global default) or in your project root (project-level override). Project root takes precedence.

## CLI reference

```bash
# Generate artifacts from a session JSON (slash command path)
npx tsx src/index.ts generate --mode interview-qa --json ~/.career-mode-session.json

# Generate from git context (hook path — no --json flag)
npx tsx src/index.ts generate --mode portfolio-bullet

# List all generated artifacts
npx tsx src/index.ts list

# Override output directory
npx tsx src/index.ts generate --mode all --output-dir ./my-artifacts
```

## Project structure

```
src/
  types/          # Zod schemas — SessionSummary, TranslatorOutput, CalibrationConfig
  claude/         # LLM client — provider factory + Anthropic / OpenAI-compatible providers
  config/         # Config loader (project-root → home fallback chain)
  adapters/       # Input adapters — git context (hook path), stdin/file (slash command path)
  ingestor/       # Normalizes both paths into a SessionSummary
  prompts/        # Prompt templates (.txt) for each mode
  translators/    # One translator per mode — calls LLM, validates, renders markdown
  output/         # Renderer (frontmatter + header + content) + connector interface
    connectors/   # LocalFileConnector — writes .md per session + index.yml
  mcp/            # server.ts — MCP server wrapping the same pipeline as two tools
  index.ts        # CLI entry point (commander) — `generate` and `list` commands

claude-code-integration/
  commands/       # career-mode.md — install this as a Claude Code slash command
  hooks/          # post-session.json — reference hook config
  mcp/            # .mcp.json — reference MCP server registration

tests/
  fixtures/       # sample-session.json — realistic test fixture
scripts/
  test-local.ts   # Smoke test: runs the full pipeline against the fixture
```

## Status

This is a weekend v0.1 — working but nascent. Tested on:
- Anthropic API (Claude Sonnet) and Ollama (local, no key needed)
- The `/career-mode` slash command path
- The CLI (`generate`, `list`) end-to-end against the sample fixture
- The MCP server (`dist/mcp/server.js`), two ways: `scripts/mcp-smoke-test.ts` drives it through `initialize` → `tools/list` → `list_career_artifacts` → a real `generate_career_artifact` call over the MCP client SDK; separately, `claude mcp add` + `claude mcp get` confirms Claude Code's own MCP client connects to it (`✔ Connected`)

Not yet tested end-to-end:
- OpenAI provider
- The git commit hook path
- `npm link` / `npx career-mode-mcp` as installed global binaries

Contributions and issues welcome.
