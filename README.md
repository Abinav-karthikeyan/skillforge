# skill-forge

[![npm version](https://img.shields.io/npm/v/@abhinavravich1999/skill-forge)](https://www.npmjs.com/package/@abhinavravich1999/skill-forge)
[![CI](https://github.com/Abinav-karthikeyan/skillforge/actions/workflows/ci.yml/badge.svg)](https://github.com/Abinav-karthikeyan/skillforge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Your sessions already contain your best career stories. skill-forge extracts them before you forget.

You just spent four hours debugging a race condition, or designed a provider abstraction that handles five LLM backends, or ripped out legacy auth middleware because legal flagged a compliance gap. In a week you'll remember "fixed some bug." In six months, nothing. Interviews and resumes are reconstructed from faded memory, months after the specifics vanished.

**skill-forge captures session context at peak richness** — right now, while the conversation is still open — and translates it into artifacts you can actually use: STAR-format interview answers, XYZ resume bullets, and technical narratives ready for a portfolio or blog post.

---

## "Couldn't you just write a skill for this?"

Yes — and that's exactly what skill-forge is *not*.

skill-forge is a different category of thing:


The slash command (`/skill-forge`) is the lowest-friction entry point. It is not the whole product.

---

## How it works

A single pipeline — `ingestor → translators → output` — exposed four ways:

| Surface | When you'd use it | Context source |
|---|---|---|
| **`/skill-forge`** slash command | End of a Claude Code session | Full conversation transcript — richest signal |
| **MCP server** (`skill-forge-mcp`) | Any MCP-capable host: Claude Desktop, custom tooling | Tool call args (`session_summary`), or git fallback |
| **CLI** (`skill-forge generate`) | Scripts, CI, or piping a git diff | `--json` file, or local git log/diff |
| **git commit hook** | Every commit, zero extra steps | git log + diff — no session required |

All four surfaces feed the same pipeline. The `/skill-forge` slash command produces the richest output because it has the full conversation; the git hook produces the leanest because it works purely from diff context. Same typed contract at the output end either way.

---

## The pipeline

```
session context  →  ingestor  →  SessionSummary  →  translators  →  connector  →  artifact
```

**Ingestor** normalizes raw context — a conversation transcript, a git diff, or a JSON blob — into a validated `SessionSummary` schema:

```ts
{
  one_liner, problem_statement, approach,
  tradeoffs: [{ decision, reasoning, alternative_considered }],
  dead_ends: string[],
  technologies: string[],
  patterns_used: string[],
  complexity_signals: { files_touched, lines_changed, test_coverage, debugging_involved }
}
```

This typed contract is what makes translators swappable. Adding a new output mode means writing a new translator against the schema — not re-engineering context extraction.

**Translators** are per-mode LLM calls against versioned prompt templates. Prompt quality is iterable independently of code — pin a version, A/B test, roll back. A skill's prompt is frozen in the `.md` file.

**Connectors** are swappable output destinations. `local` writes `.md` files and maintains `index.yml`. `gist` pushes each artifact to a GitHub Gist and returns a shareable URL. `notion` creates a page in a Notion database with structured properties. `return_only` writes locally **and returns the fully rendered artifact to the caller** so the *host* delivers it via a connector it already has — Slack, LinkedIn, Google Docs, or a **Gemini Notebook / NotebookLM** source (see [Connect to Gemini Notebook](#7-optional-connect-to-gemini-notebook--notebooklm)). All non-local connectors also write locally so `index.yml` stays authoritative.

---

## Quickstart

### 1. Install

```bash
npm install -g @abhinavravich1999/skill-forge
```

Or run without installing:

```bash
npx @abhinavravich1999/skill-forge generate --help
```

> **Upgrading from `career-mode`?** This release renames everything to `skill-forge`, with
> one-release fallbacks so nothing breaks: your existing `~/.career-mode/` corpus and
> `career-mode.config.yaml` are still read, the `CAREER_MODE_PROMPT_VERSION` env var still
> works, and the old MCP tool names (`generate_career_artifact`, `list_career_artifacts`)
> still resolve (deprecated — switch to the `*_skill_forge_*` names). The one thing to do by
> hand: if you installed the old slash command, delete `~/.claude/commands/career-mode.md`
> and install `/skill-forge` (step 3) so you don't have both. These fallbacks are removed in
> the next release.

### 2. Configure your LLM provider

skill-forge has its own LLM client, independent of whatever powers your Claude Code session. The recommended path is `openai-compatible` — it works with DeepSeek, Groq, Together, Fireworks, xAI, LM Studio, vLLM, Ollama, and OpenAI itself.

```bash
cp skill-forge.config.yaml ~/.skill-forge/config.yaml
cp .env.example .env
```

Edit `~/.skill-forge/config.yaml`. DeepSeek is fast and cheap — a good default:

```yaml
provider: openai-compatible
model: deepseek-chat
base_url: https://api.deepseek.com/v1
api_key: ${DEEPSEEK_API_KEY}       # resolved from .env — secrets stay out of yaml
```

Add the key to `.env`:

```
DEEPSEEK_API_KEY=sk-...
```

`.env` is loaded from project root first, then `~/.skill-forge/.env`. Shell env always wins.

**Skip the config file entirely** and the provider auto-detects from env:

| Env var set | Provider used |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic (Claude, native SDK) |
| `OPENAI_API_KEY` | OpenAI (`api.openai.com`) |
| Neither | Ollama at `localhost:11434` |

### 3. Install the slash command

```bash
# macOS / Linux
cp claude-code-integration/commands/skill-forge.md ~/.claude/commands/skill-forge.md

# Windows (PowerShell)
Copy-Item claude-code-integration\commands\skill-forge.md "$env:USERPROFILE\.claude\commands\skill-forge.md"
```

Restart Claude Code. `/skill-forge` is now available in any session.

### 4. (Optional) Register the MCP server

Register skill-forge as an MCP server so any MCP-capable client can call it as a tool — including Claude Code, Claude Desktop, or your own tooling:

```bash
claude mcp add skill-forge -- npx --package=@abhinavravich1999/skill-forge skill-forge-mcp
```

Or add it to `.mcp.json` directly — see [claude-code-integration/mcp/.mcp.json](claude-code-integration/mcp/.mcp.json). Full tool schemas and the reasoning for running both the slash command and MCP server: [docs/mcp-server.md](docs/mcp-server.md).

### 5. (Optional) Install the git commit hook

Fire skill-forge on every commit — no session required, no extra steps:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "pattern": "git commit",
        "command": "npx @abhinavravich1999/skill-forge generate --mode portfolio-bullet"
      }
    ]
  }
}
```

Add this to `~/.claude/settings.json` under `hooks`.

### 6. (Optional) Connect to Notion

Push artifacts directly into a Notion database — turn skill-forge into a living brag doc.

**One command does everything** — token validation, database creation, config write:

```bash
skill-forge auth notion
```

The guided flow:

1. Creates a Notion integration at https://www.notion.so/profile/integrations
2. Shares a page with the integration in the Notion UI
3. Pastes the integration token when prompted (input is hidden — never logged)
4. Picks the parent page from a list (or pastes a URL/ID)
5. Done — the database is created, credentials written to `~/.skill-forge/.env`, config updated

Artifacts now land in Notion with full metadata (Mode, Technologies, Patterns) as database properties.

**Check status at any time:**

```bash
skill-forge auth status
```

**From an MCP host** (Claude Code, Claude Desktop, etc.) — call `notion_auth_status` to see whether Notion is configured without leaving your session.

<details>
<summary>Manual / non-interactive setup</summary>

```bash
# 1. Add NOTION_TOKEN=ntn_... to ~/.skill-forge/.env
# 2. Create the database:
npx tsx scripts/notion-setup.ts <parent-page-id>
# 3. Add to ~/.skill-forge/config.yaml:
#   connector: notion
#   notion_token: ${NOTION_TOKEN}
#   notion_database_id: <printed-id>
```

</details>

### 7. (Optional) Connect to Gemini Notebook / NotebookLM

Push artifacts into a **Gemini Notebook** (formerly NotebookLM) so you can chat over your own
career corpus with grounded, cited answers.

There is a deliberate design choice here: skill-forge does **not** ship a Gemini Notebook
connector that holds your Google credentials. Google exposes no official consumer write API,
so a bespoke connector would mean skill-forge driving a headless Chrome with your cookies —
fragile and a credential liability. Instead, skill-forge uses **host-delivery**: it renders the
artifact and hands it back, and a NotebookLM MCP that *you* have authorized does the delivery.
skill-forge holds zero Google credentials.

**One-time setup** — install a NotebookLM MCP CLI (any that exposes an `add_source` / `source add`
tool with a text/paste type works; [`notebooklm-mcp-cli`](https://github.com/jacob-bd/notebooklm-mcp-cli)
is one) and authenticate it once:

```bash
pip install notebooklm-mcp-cli
nlm login                         # opens Chrome; sign into your Google account once
nlm notebook create "My career corpus"    # prints a notebook id + URL
```

**Deliver an artifact** — generate with the `return_only` connector, then hand the rendered
markdown to the notebook as a text source:

```bash
# 1. Render + return (also saved to your local corpus)
skill-forge generate --mode technical-deep-dive --connector return_only --json session.json

# 2. Add the saved artifact to the notebook as a text source
nlm source add <notebook-id> --text "$(cat ~/.skill-forge/artifacts/<file>.md)" \
  --title "Career artifact" --wait
```

Inside an MCP host (Claude Code, Claude Desktop) that has *both* skill-forge and a NotebookLM
MCP connected, this is one sentence: *"generate a technical deep-dive and add it to my Gemini
Notebook."* The host calls `generate_skill_forge_artifact` with `connector: "return_only"`, gets the
markdown back, and calls the NotebookLM MCP's `add_source(type=text)` with it — no glue code.

> **Verified round-trip:** `generate --connector return_only` → `nlm source add --text` ingests
> cleanly and a grounded query answers while citing the artifact. `technical-deep-dive` and
> `interview-qa` ground richer "why" questions than terse `portfolio-bullet`; the flow is
> identical across modes.

The same `return_only` mode is the recommended path for Slack, LinkedIn, and Google Docs too —
wherever the host already holds the credential.

---

## Using the slash command

At the end of a Claude Code session:

```
/skill-forge
```

Claude synthesizes the session into a structured summary, runs it through the pipeline, and writes an artifact to `~/.skill-forge/artifacts/`. The output path is printed in the terminal.

Specify the mode:

```
/skill-forge --mode interview-qa
/skill-forge --mode portfolio-bullet
/skill-forge --mode technical-deep-dive
/skill-forge --mode all
```

Default is `interview-qa`. See [docs/slash-command.md](docs/slash-command.md) for a full walkthrough.

---

## Output modes

### `interview-qa`
2–4 STAR-format interview questions with full answers (Situation, Task, Action, Result), follow-up questions an interviewer would actually ask, and a calibration note on how to pitch the answer for your experience level.

### `portfolio-bullet`
3–5 resume bullets in XYZ format ("Accomplished X by doing Y, resulting in Z"). Calibrated to `experience_level` and `target_role` in config.

### `technical-deep-dive`
A technical narrative for a blog post, design doc, or engineering portfolio — problem, approach, tradeoffs, and lessons learned, structured for an engineering audience.

### `all`
All three modes, separate files.

---

## Custom instructions

skill-forge injects your custom instructions into every translator system prompt — giving the LLM context it cannot infer from git alone.

Add `custom_instructions` to `~/.skill-forge/config.yaml`:

```yaml
# Simple: one string applies to all modes
custom_instructions: >
  I'm targeting Staff Engineer roles at fintech companies (Stripe, Plaid, Square).
  Emphasize reliability, distributed systems, and compliance angles.
  Tie every technical decision back to business impact.
```

```yaml
# Per-mode: global applies everywhere, mode keys add overrides
custom_instructions:
  global: "Audience is senior engineers and EMs. Prefer precision over broad claims."
  interview-qa: "Weight cross-team influence and leadership stories more heavily."
  portfolio-bullet: "Lead with impact metrics. Format: Reduced X by Y, enabling Z."
  technical-deep-dive: "Write for a principal-level audience; include explicit trade-off reasoning."
```

The instructions appear as a clearly delimited block at the end of the system prompt — they don't modify the prompt template files, so you can iterate them independently.

---

## Prompt eval

Compare prompt versions across all fixtures to catch regressions before promoting a new version:

```bash
# Run all fixtures × all modes × all declared versions
npx tsx scripts/prompt-eval.ts

# Compare two versions on a single mode
npx tsx scripts/prompt-eval.ts --versions v1,v2 --modes interview-qa

# Limit to specific fixtures
npx tsx scripts/prompt-eval.ts --fixtures debugging-memory-leak,greenfield-auth-service
```

Outputs land in `test-output/eval/<timestamp>/` (gitignored). Each file gets frontmatter with fixture name, mode, version, and elapsed time. Diff any two versions:

```bash
diff test-output/eval/<timestamp>/debugging-memory-leak/interview-qa-v1.md \
     test-output/eval/<timestamp>/debugging-memory-leak/interview-qa-v2.md
```

To add a new prompt version: create `src/prompts/<mode>/v2.txt`, add it to `src/prompts/manifest.yaml`, then run eval before updating `active`.

---

## Configuration

`~/.skill-forge/config.yaml` (global) or `<project-root>/skill-forge.config.yaml` (project override — takes precedence):

```yaml
experience_level: senior       # junior | mid | senior | staff
tone: balanced                 # technical | business | balanced
output_dir: ~/.skill-forge/artifacts

# Provider — auto-detected from env if omitted
# provider: anthropic
# model: claude-sonnet-4-6

# provider: openai
# model: gpt-4o-mini

# provider: ollama
# model: llama3.2
# base_url: http://localhost:11434/v1

# provider: openai-compatible   # Groq, Together AI, LM Studio, DeepSeek, etc.
# model: mixtral-8x7b-32768
# base_url: https://api.groq.com/openai/v1
# api_key: gsk_...

# Optional calibration
# target_role: Staff Engineer
# company_size: startup         # startup | mid | enterprise
# default_mode: portfolio-bullet

# Output connector
# connector: local              # default — writes ~/.skill-forge/artifacts/
# connector: gist               # also pushes each artifact to a GitHub Gist
# gist_token: ghp_...           # or set GITHUB_TOKEN (needs `gist` scope)
# gist_public: false            # default: secret gist
# connector: notion             # also creates a Notion page with metadata
# notion_token: ${NOTION_TOKEN}         # run `skill-forge auth notion` to set up
# notion_database_id: ${NOTION_DATABASE_ID}
# connector: return_only        # writes locally AND returns the rendered artifact so the
#                               # host delivers it (Gemini Notebook, Slack, LinkedIn, Docs).
#                               # Holds zero third-party credentials — see the README.

# Custom instructions — injected into every translator system prompt.
# Give skill-forge context it can't infer from git: interview targets, tone, what to emphasize.
#
# Flat string (applies to all modes):
# custom_instructions: >
#   I'm targeting Staff Engineer roles at fintech companies.
#   Emphasize reliability, distributed systems, and compliance angles.
#   Tie technical decisions back to business impact and customer trust.
#
# Per-mode object:
# custom_instructions:
#   global: "Targeting infra/platform roles. Prefer precision over broad claims."
#   interview-qa: "Weight cross-team influence and technical leadership stories."
#   portfolio-bullet: "Lead with business-impact metrics. Format: Reduced X by Y, enabling Z."
#   technical-deep-dive: "Write for a principal-level audience. Include explicit trade-off reasoning."
```

---

## CLI reference

```bash
# Generate from a session JSON (slash command path)
skill-forge generate --mode interview-qa --json ~/.skill-forge-session.json

# Generate from git context (hook path — no --json)
skill-forge generate --mode portfolio-bullet

# List all generated artifacts
skill-forge list

# Push the most recent artifact to a GitHub Gist
skill-forge share

# Host-delivery: render + return the artifact for the host to deliver (Gemini Notebook, Slack, …)
skill-forge generate --mode technical-deep-dive --connector return_only --json session.json

# Override output directory
skill-forge generate --mode all --output-dir ./my-artifacts

# Auth subcommands
skill-forge auth notion          # guided Notion setup (interactive)
skill-forge auth status          # show which connectors are authenticated
```

---

## Project structure

```
src/
  types/          # Zod schemas — SessionSummary, TranslatorOutput, CalibrationConfig
  claude/         # LLM client — provider factory + Anthropic / OpenAI-compatible providers
  config/         # Config loader (project-root → home fallback chain), .env loader
  adapters/       # Input adapters — git context (hook path), stdin/file (slash command path)
  ingestor/       # Normalizes all input paths into a typed SessionSummary
  prompts/        # Versioned prompt templates (.txt) per mode
  translators/    # One translator per mode — LLM call, validation, markdown render
  output/         # Renderer (frontmatter + header + content) + connector interface
    connectors/   # LocalFileConnector, GistConnector, NotionConnector + self-registering registry
  auth/           # Connector auth flows — notion.ts (interactive), config-writer.ts (env/.yaml merge)
  mcp/            # server.ts — MCP server: generate, list, share, notion_auth_status tools
  index.ts        # CLI entry point — generate, list, share, auth subcommands

claude-code-integration/
  commands/       # skill-forge.md — install as a Claude Code slash command
  hooks/          # post-session.json — reference hook config
  mcp/            # .mcp.json — reference MCP server registration

tests/
  fixtures/       # Realistic session fixtures for eval (rate limiter, auth service, memory leak, monolith extraction, ML pipeline)
  ingestor.test.ts, renderer.test.ts, mcp-server.test.ts
  connectors/     # local-file, gist (mocked fetch), notion (mocked client), notion-blocks
  translators/    # prompt loading, version resolution, interpolation, custom instructions
scripts/
  test-local.ts          # Smoke test: full pipeline against the fixture
  mcp-smoke-test.ts      # MCP protocol smoke test (spawns dist/mcp/server.js)
  test-share-notion.ts   # Targeted test: share_last_artifact → notion via MCP
  notion-setup.ts        # Manual database creation (non-interactive fallback)
  prompt-eval.ts         # Prompt eval harness: runs fixtures × modes × versions for side-by-side comparison
```

---

## Development & testing

```bash
npm install
npm run build       # tsc + copies prompt templates into dist/
npm test            # Vitest — unit tests (ingestor, renderer, prompts, connectors) + MCP integration test
npm run typecheck   # tsc --noEmit over src + tests
```

The MCP integration test (`tests/mcp-server.test.ts`) spawns `dist/mcp/server.js` over stdio and asserts the full tool surface — run `npm run build` before it. CI runs build → test → typecheck on Node 20 and 22, Ubuntu and Windows.

---

## Status

v0.1 — working, weekend-built. Tested on:

- Automated test suite: 74 Vitest tests across 11 files (ingestor, renderer, prompt loader/version resolution, local/gist/notion connectors, return_only host-delivery, orchestrator/scout, MCP server integration) + GitHub Actions CI on Node 20/22, Ubuntu/Windows
- Anthropic API (Claude Sonnet), Ollama (local, no key), DeepSeek via `openai-compatible`
- `/skill-forge` slash command path end-to-end
- CLI (`generate`, `list`, `share`, `auth notion`, `auth status`) against real APIs
- MCP server: `scripts/mcp-smoke-test.ts` drives `initialize → tools/list → list_skill_forge_artifacts → generate_skill_forge_artifact` over MCP client SDK; `claude mcp add` + `claude mcp get` confirms Claude Code's own MCP client connects (`✔ Connected`)
- `.env` loading with `${VAR}` config indirection, verified by `scripts/deepseek-smoke-test.ts`
- Gist connector — offline (mocked fetch) and live via the MCP `share_last_artifact` tool
- Notion connector — live end-to-end: `generate --connector notion` (both `interview-qa` and `portfolio-bullet`), `share_last_artifact --destination notion` via MCP; properties (Title, Mode, Technologies, Date, Patterns) all populated
- `return_only` host-delivery — live end-to-end into **Gemini Notebook / NotebookLM** via `notebooklm-mcp-cli`: `generate --connector return_only` → `nlm source add --text` (both `portfolio-bullet` and `technical-deep-dive`); source ingested and a grounded query answered while citing the artifact

Not yet tested end-to-end:
- OpenAI direct provider (`provider: openai` — the `openai-compatible` path with `base_url: https://api.openai.com/v1` is equivalent and works)
- git commit hook path
- `npm link` / `npx skill-forge-mcp` as installed global binaries

Contributions and issues welcome.
