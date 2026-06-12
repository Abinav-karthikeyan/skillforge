# `/career-mode` slash command

The `/career-mode` slash command is a Claude Code skill that captures the current session's context and translates it into career artifacts without leaving the terminal.

## Why the slash command, not just the hook?

The git commit hook runs on every commit and only sees the git diff. It's useful for passive capture but the context is shallow — it knows *what* changed, not *why* you made the tradeoff, *what* you tried first, or *what* you learned.

The slash command runs at the end of a session and has access to the full conversation transcript. That's the difference between "added Redis caching" and "chose Redis over in-memory cache because the service runs across three pods and in-memory state would be inconsistent — considered sticky sessions but that would've constrained the autoscaling policy."

Use the hook for passive coverage. Use the slash command when you just finished something worth capturing properly.

## Installation

### Step 1 — Clone and install the repo

```bash
git clone https://github.com/your-username/careermode-mcp
cd careermode-mcp
npm install
```

### Step 2 — Configure your LLM provider

Copy the sample config:

```bash
# macOS / Linux
cp career-mode.config.yaml ~/.career-mode/config.yaml

# Windows
Copy-Item career-mode.config.yaml "$env:USERPROFILE\.career-mode\config.yaml"
```

Edit `~/.career-mode/config.yaml` and uncomment your provider:

```yaml
experience_level: senior   # junior | mid | senior | staff
tone: balanced

provider: anthropic
model: claude-sonnet-4-6
# api_key: sk-ant-...      # or set ANTHROPIC_API_KEY env var
```

If you skip the config file entirely, the CLI auto-detects:
- `ANTHROPIC_API_KEY` set → Anthropic
- `OPENAI_API_KEY` set → OpenAI
- Neither → Ollama at `localhost:11434`

### Step 3 — Install the slash command file

Claude Code loads slash commands from `~/.claude/commands/` (global) or `.claude/commands/` in your project (project-scoped).

```bash
# macOS / Linux — global install (available in every session)
cp claude-code-integration/commands/career-mode.md ~/.claude/commands/career-mode.md

# Windows
Copy-Item claude-code-integration\commands\career-mode.md "$env:USERPROFILE\.claude\commands\career-mode.md"
```

**Restart Claude Code** after copying. The `/career-mode` command will appear in autocomplete.

### Step 4 — Verify

Open any Claude Code session and type `/career-mode`. Claude should acknowledge the command and begin synthesizing the session. If it doesn't appear in autocomplete, check that the file is in the right directory and that you restarted.

## Usage

### Basic invocation

At the end of a session, type:

```
/career-mode
```

Claude will:
1. Read the full conversation transcript
2. Extract: one-liner, problem statement, approach, tradeoffs, dead ends, technologies, patterns used, complexity signals
3. Write a `SessionSummary` JSON to a temp file
4. Call `npx tsx src/index.ts generate --mode interview-qa --json <tempfile>`
5. Print the output file path

### Specifying a mode

```
/career-mode --mode portfolio-bullet
/career-mode --mode technical-deep-dive
/career-mode --mode all
```

| Mode | Output |
|---|---|
| `interview-qa` | 2–4 interview Q&As with STAR answers and follow-up questions |
| `portfolio-bullet` | 3–5 resume bullets in XYZ format |
| `technical-deep-dive` | Long-form technical narrative (blog/portfolio style) |
| `all` | All three, written to separate files |

Default is `interview-qa`.

## What Claude extracts from the session

The slash command instructs Claude to synthesize a `SessionSummary` with these fields:

| Field | What it captures |
|---|---|
| `one_liner` | One sentence: what was built or fixed |
| `problem_statement` | Why it needed to be done |
| `approach` | How it was solved |
| `tradeoffs` | Actual decisions made — `{decision, reasoning, alternative_considered}` |
| `dead_ends` | What was tried and abandoned |
| `technologies` | Stack items mentioned in the session |
| `patterns_used` | Design patterns, architectural decisions |
| `complexity_signals` | `files_touched`, `lines_changed`, `test_coverage`, `debugging_involved` |

Tradeoffs are the most valuable field for interview prep. Claude is instructed to be specific — "chose Redis over in-memory cache because X" not "made architectural decisions."

## Output format

Artifacts are written to `~/.career-mode/artifacts/` (or `output_dir` from config). Each artifact is a `.md` file with YAML frontmatter:

```yaml
---
mode: interview-qa
session_id: 94da98d5-...
date: 2026-06-12
technologies: [TypeScript, Redis, Node.js]
source: claude-code
---
```

An `index.yml` is updated on every write. Run `npx tsx src/index.ts list` to see all artifacts.

### Interview Q&A format

Each question includes:
- The question itself
- Category: `system-design | behavioural | debugging | technical-depth`
- Full STAR answer (Situation, Task, Action, Result)
- 2–3 follow-up questions an interviewer might ask
- A `calibration_note` on how to pitch the answer for your experience level

### Portfolio bullet format

Bullets follow XYZ: "Accomplished [X] by doing [Y], resulting in [Z]." Calibrated to `experience_level` in your config — a staff-level bullet leads with impact and scale; a junior-level bullet leads with the technical action.

## Troubleshooting

**`/career-mode` doesn't appear in autocomplete**
- Check the file exists at `~/.claude/commands/career-mode.md`
- Restart Claude Code (the command registry is loaded at startup)

**`model 'llama3.2' not found` error**
- The CLI defaulted to Ollama because no API key was found
- Set `ANTHROPIC_API_KEY` in your environment, or add `provider: anthropic` to `~/.career-mode/config.yaml`

**Output is empty or malformed**
- Check that `npx tsx` works in your terminal (`npx tsx --version`)
- Run the smoke test: `npx tsx scripts/test-local.ts --mode interview-qa` with your API key set

## The slash command file

The file at `claude-code-integration/commands/career-mode.md` is what Claude Code loads as the `/career-mode` command. It contains instructions that Claude follows when the command is invoked — it's a prompt, not a script. You can customize it: change the default mode, add fields to extract, or adjust how tradeoffs are captured.

The file is versioned in the repo so updates to the command ship with the project.
