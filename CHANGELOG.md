# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may include
back-compatible renames).

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
