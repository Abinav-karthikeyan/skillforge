---
name: skill-forge
description: >-
  Turn a coding session into interview-ready STAR Q&A, resume/portfolio bullets,
  or a technical deep-dive, using the published skill-forge CLI/MCP as the typed,
  calibrated generation engine. Use this whenever someone wants to capture what
  they just built for career purposes — prepping for an interview, updating a
  resume or brag doc, writing portfolio bullets, drafting a performance-review
  packet, or turning recent commits/PRs into stories — even if they never say
  "skill-forge". Trigger on things like "help me talk about this in an
  interview", "turn what I did into a resume bullet", "write this up for my brag
  doc", "STAR answers for this project", "portfolio bullet", or "summarize this
  session for my career". Prefer this over free-handing a summary: it produces
  typed, calibrated output routed to a file, Notion, a Gist, or the host.
license: MIT
metadata:
  package: "@abhinavravich1999/skill-forge"
  homepage: "https://github.com/Abinav-karthikeyan/skillforge"
---

# skill-forge

Anyone can write a prompt that says "summarize my session." skill-forge is the
engine that makes the output **typed, calibrated, and routable**: it takes a
structured summary of a coding session and renders it into one of three career
artifacts through versioned, experience-level-calibrated prompts. Your job when
this skill triggers is to (1) make sure the engine is runnable, (2) synthesize a
faithful structured summary of the session from the conversation, and (3) invoke
the engine and hand back the result.

The quality of the output is almost entirely determined by the quality of the
summary you synthesize. A session's richest career stories live in the
*tradeoffs* and *dead ends* — capture those, not just what was built.

## Step 1 — Make sure the engine is available (one-time)

skill-forge is published to npm as `@abhinavravich1999/skill-forge` (bins
`skill-forge` and `skill-forge-mcp`) and needs Node ≥ 20 plus an LLM provider.

- **Is the CLI there?** Run `skill-forge --help`. If it's missing, either install
  it globally (`npm i -g @abhinavravich1999/skill-forge`) or call it with no
  install via `npx -y @abhinavravich1999/skill-forge@latest …` in place of
  `skill-forge` in every command below.
- **Is a provider configured?** Generation makes one LLM call per mode. If no
  provider is set up, `generate` errors. If you hit that, read
  [references/setup.md](references/setup.md) and help the user configure one
  (DeepSeek, OpenAI, Anthropic, Groq, Ollama, … — any OpenAI-compatible endpoint,
  configured user-globally so it's found from any working directory).

If an MCP tool named `generate_skill_forge_artifact` is already available in your
session, the engine is installed and configured — skip straight to Step 2 and use
the tool form in Step 3.

## Step 2 — Synthesize the session summary (the part that matters)

Read back over the conversation and distill it into the structured shape below.
Do not pad it — extract what actually happened. The engine reads this JSON, so
every field you fill well becomes a sharper artifact.

Key fields (full schema + a worked example in
[references/session-summary.md](references/session-summary.md)):

- `one_liner` — one sentence naming the accomplishment.
- `problem_statement` — what was hard / why it mattered.
- `approach` — how it was actually solved.
- `tradeoffs[]` — each `{decision, reasoning, alternative_considered}`. **This is
  where interview gold lives.** A decision with a real alternative you rejected is
  a system-design answer waiting to happen.
- `dead_ends[]` — false starts and what they taught. These become the honest,
  self-aware behavioural/debugging answers that make a candidate credible.
- `technologies[]`, `patterns_used[]`, and `complexity_signals`
  (`files_touched`, `lines_changed`, `test_coverage`, `debugging_involved`).

If the session is thin (e.g. you were only asked to summarize a git range), you
may omit `--json` entirely and let the CLI fall back to summarizing the local
`git log`/diff — but a hand-synthesized summary is always richer.

## Step 3 — Generate

**Preferred, if the MCP tool is present:** call `generate_skill_forge_artifact`
with your synthesized summary under `session_summary` and the chosen `mode`. The
host writes the artifact and (with `connector: return_only`) hands the rendered
markdown straight back to you to deliver however the user has connectors set up.

**Otherwise, via the CLI:** write the summary to a temp JSON file and run:

```bash
skill-forge generate --mode interview-qa --json /tmp/session.json
```

Common flags:

- `--mode <interview-qa | portfolio-bullet | technical-deep-dive | all>`
- `--json <path>` — your synthesized summary (omit to fall back to git context).
- `--output-dir <dir>` — where to write (default: `~/.skill-forge/artifacts/`).
- `--connector <local | gist | notion | return_only>` — where it goes (see Step 4).
- `--focus "<lens>" --focus-effort <low|medium|off>` — interview-qa only (see below).
- `--with-code-facts [--range <git range>]` — attach deterministic code facts (see below).
- `--story <id>` — regenerate a living artifact in place (versioned) instead of adding a new one.

Then tell the user what was produced and where. `skill-forge list` shows the
artifact index.

## Code facts: let measured numbers replace estimates

When the session's work is committed, add `--with-code-facts` (MCP:
`with_code_facts: true`, plus `range` if the work spans several commits, e.g.
`main..HEAD`). skill-forge then computes facts from git: files and lines changed;
with the optional `@abhinavravich1999/skill-forge-codeintel` companion, also which
functions/classes were added, modified, renamed, or moved, cyclomatic complexity
before → after, public API changes, linked tests, and an approximate blast radius.
Artifacts may then **only** state numbers that appear in those facts, so a bullet
like "cut `parseToken`'s complexity from 14 to 6" is a fact, not a guess.
`skill-forge codeintel status` shows which layer is active, and
`skill-forge codeintel digest main..HEAD` prints what was measured.

Don't put numbers in `complexity_signals` yourself when code facts are attached;
they are overwritten with measured values.

**If you have an LSP / code-navigation tool** (e.g. Claude Code's LSP
`findReferences`, a Serena or Sourcegraph MCP), you can upgrade the blast radius
from approximate to precise. For the most important changed public symbols
(`code_facts.blast_radius`), count the referencing files with that tool and put the
result in the summary's `code_facts.blast_radius` entries with
`approximate: false`, and set `code_facts.layer` to `"L2"` and `code_facts.source`
to `"lsp"`. Only do this with real tool results; never mark a guessed count as
precise.

## Choosing a mode

| The user wants… | Mode |
|---|---|
| To rehearse for an interview (STAR answers + follow-ups + calibration notes) | `interview-qa` |
| A resume line or a "wins"/brag-doc bullet | `portfolio-bullet` |
| To explain a hard technical decision to a senior/principal audience | `technical-deep-dive` |
| All three at once | `all` |

## Focus lens (interview-qa only)

When the user is prepping for a *specific* kind of interview ("this is a
distributed-systems screen", "they care about reliability"), pass a focus lens:

```bash
skill-forge generate --mode interview-qa --json /tmp/session.json \
  --focus "distributed systems and failure handling" --focus-effort medium
```

`--focus-effort medium` lets a budgeted, sandboxed scout read the repo for
corroborating evidence before weighting which stories surface; `low` (default)
skips repo tools; `off` disables the lens. It degrades gracefully — a failed
scout falls back to plain-text focus, never an error.

## Step 4 — Delivery

The engine always writes locally so `list`/`share` keep working, and can also
route the artifact:

- `local` (default) — `~/.skill-forge/artifacts/<file>.md` + `index.yml`.
- `return_only` — writes locally **and returns the rendered markdown to you**, so
  *you* deliver it through whatever connectors the host already has (Slack,
  Notion, Google Docs, LinkedIn draft…). Prefer this when the user wants the
  result somewhere the host can post it — it needs zero skill-forge credentials.
- `gist` — also pushes to a secret GitHub Gist and returns a URL (needs a
  `gist`-scoped token).
- `notion` — appends to a configured Notion database (needs `NOTION_TOKEN` +
  `notion_database_id`).

`skill-forge share --destination gist|notion` pushes the most recent artifact
after the fact.

## Notes & graceful failure

- **Tone/level** come from config (`experience_level`, `tone`,
  `custom_instructions`) — see [references/setup.md](references/setup.md). If the
  user says "make it staff-level" or "target fintech roles", set
  `custom_instructions` rather than hand-editing output.
- If generation fails for lack of a provider, don't fake an artifact — walk the
  user through setup instead.
- Don't invent facts to fill the summary. An honest, specific `dead_ends` entry
  beats a polished fabrication, and the artifacts are meant to be things the user
  can defend in a real interview.
