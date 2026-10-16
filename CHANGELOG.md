# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may include
back-compatible renames).

## Unreleased — v3

Work toward the v3 roadmap in `plan_v3.md`, one phase at a time.

### Phase 3.0 — Foundations
- **Judge (v2 Bet 6).** `skill-forge judge <artifact> --json <summary.json>` (or
  `--story <id>`) scores an artifact on STAR completeness, specificity, groundedness,
  metric honesty and calibration fit. Metric honesty is deterministic: every number in
  the artifact must appear in the session's ground truth. `scripts/prompt-eval.ts --judge`
  scores every eval output and writes `scores.json` plus a per-version mean table.
- **Data model v2.** Zod schemas for `ObservedEvent`, `Evidence`, `Observation` and
  `Story` (`src/types/ledger.ts`, `src/types/evidence.ts`); `projectStory()` turns a
  story back into a `SessionSummary` so translators are unchanged. `SessionSummary`
  gains optional `schema_version`, `story_id` and `summary.evidence`.
- **Story ledger + living artifacts.** Every `generate` run is recorded as a story
  in `<artifacts>/.ledger/`. `generate --story <id>` (or `story_id` over MCP) updates an
  artifact in place: `index.yml` upserts by `(story_id, mode)`, the version climbs, and
  the previous body is archived under `versions/`. Story-less writes keep the v2 append
  behaviour byte-for-byte. `skill-forge stories list|show|migrate|approve|discard`;
  legacy `index.yml` artifacts load as one-version stories.
- **Commit hook fixed.** The reference hook uses the current Claude Code schema
  (`matcher` + nested `hooks`, `if: "Bash(git commit*)"`, `async: true`) and calls the
  new `skill-forge hook post-commit` entry point instead of `npx`. The hook reads the
  payload on stdin, always exits 0, and logs to `~/.skill-forge/logs/hook.log`.
- **Named budget tiers.** `low` / `medium` (unchanged) plus `evidence` and `discovery`;
  `budgetTier()` throws on unknown names instead of silently defaulting.
- **Native tool-use runtime.** `subagent_runtime: native | claude-sdk | openai-agents`
  runs the scout's bounded tool loop through Anthropic Messages tool use or OpenAI
  Chat Completions function calling. `auto` still uses the portable inline loop.
- `LLMClient.chat()` takes optional `{ temperature, max_tokens }`; temperature is
  dropped for Claude models that reject sampling parameters.
- The CLI and MCP server report the version from `package.json` (both said `0.1.0`).
- `generate --mode` now rejects unknown modes instead of silently running deep-dive.

## 0.2.0

The "one name + host-delivery" release. Everything is now **skill-forge**, and artifacts
can be delivered by the host instead of by credentials skill-forge holds.

### Added
- **`return_only` host-delivery output mode.** `generate --connector return_only` (and the
  MCP tool's `connector: "return_only"`) writes the artifact to your local corpus **and
  returns the fully rendered markdown** with a destination-agnostic delivery instruction, so
  the host delivers it via a connector it already has — Slack, LinkedIn, Google Docs, or a
  **Gemini Notebook / NotebookLM** source (`add_source(type=text)`). skill-forge holds zero
  third-party credentials. Verified end-to-end into NotebookLM via `notebooklm-mcp-cli`.
- CHANGELOG.

### Changed — the `career-mode → skill-forge` rename (P0.1)
One name everywhere: config dir `~/.skill-forge/`, project config file
`skill-forge.config.yaml`, env var `SKILL_FORGE_PROMPT_VERSION`, the `/skill-forge` slash
command, and the MCP tools `generate_skill_forge_artifact` / `list_skill_forge_artifacts`.
User-facing strings, README, and docs all updated.

### Deprecated (still work this release, removed in the next)
- Config dir `~/.career-mode/` — still read if present (fresh installs use `~/.skill-forge/`).
- Project config filename `career-mode.config.yaml` — still read as a fallback.
- Env var `CAREER_MODE_PROMPT_VERSION` — still honored (`SKILL_FORGE_PROMPT_VERSION` wins).
- MCP tools `generate_career_artifact` / `list_career_artifacts` — still registered
  (marked `[DEPRECATED]`); switch to the `*_skill_forge_*` names.

### Migration
If you used the previous release:
- Your existing `~/.career-mode/` corpus and `career-mode.config.yaml` keep working via the
  fallbacks above — nothing to move.
- Delete the old global slash command `~/.claude/commands/career-mode.md` and install
  `/skill-forge` so you don't have both.
- The MCP **server** name was already `skill-forge`, so no `.mcp.json` change is needed.

## 0.1.0
- Initial release: typed capture pipeline (ingestor → SessionSummary → translators →
  connectors) over four surfaces (slash command, MCP server, CLI, git hook); provider
  abstraction (Anthropic / OpenAI-compatible / Ollama); local / gist / notion connectors;
  versioned-prompt eval harness; budgeted focus-scout orchestrator.
