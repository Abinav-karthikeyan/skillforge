# Setup: install, provider config, and MCP registration

## Install the engine

Published on npm as `@abhinavravich1999/skill-forge` (Node ≥ 20).

- Global install: `npm i -g @abhinavravich1999/skill-forge` → puts `skill-forge`
  and `skill-forge-mcp` on PATH.
- No-install: prefix any command with `npx -y @abhinavravich1999/skill-forge@latest`.

## Configure a provider (required — generation makes real LLM calls)

Config is discovered from the current working directory first, then user-globally
at `~/.skill-forge/` (with a one-release fallback to a legacy `~/.career-mode/`).
Because another agent may launch skill-forge from an arbitrary directory,
**configure it user-globally** so it's always found.

Create `~/.skill-forge/config.yaml`:

```yaml
experience_level: senior        # junior | mid | senior | staff
tone: balanced                  # technical | business | balanced

# Any OpenAI-compatible endpoint (DeepSeek shown; also OpenAI, Groq, Together,
# Fireworks, xAI, LM Studio, vLLM, Ollama). ${VAR} pulls from the .env below.
provider: openai-compatible
model: deepseek-chat
base_url: https://api.deepseek.com/v1
api_key: ${DEEPSEEK_API_KEY}
```

Create `~/.skill-forge/.env` (gitignored; keep secrets here, not in the yaml):

```
DEEPSEEK_API_KEY=sk-...
```

Provider variants:

- **Anthropic** (native SDK): `provider: anthropic`, `api_key: ${ANTHROPIC_API_KEY}`
  (model defaults to the current Sonnet tier; set `model:` to override).
- **OpenAI**: `provider: openai`, `api_key: ${OPENAI_API_KEY}`.
- **Ollama** (local, no key): `provider: ollama`, `model: qwen2.5`,
  `base_url: http://localhost:11434/v1`.
- **Auto-detect** (only when `provider` is unset): `ANTHROPIC_API_KEY` →
  anthropic; else `OPENAI_API_KEY` → openai; else Ollama.

### Calibration / house style

`custom_instructions` in `config.yaml` is injected into every prompt — use it for
target role, audience, and tone. Flat string applies to all modes; a keyed object
(`global` + per-mode keys `interview-qa` / `portfolio-bullet` /
`technical-deep-dive`) targets individual modes.

## Use it as an MCP server in another agent

The stdio server is `skill-forge-mcp`. Exposed tools:
`generate_skill_forge_artifact`, `list_skill_forge_artifacts`, plus share/Notion
tools. On Windows especially, the `node` + absolute-path form is the most reliable
launcher (global `.cmd` shims sometimes trip MCP launchers).

**JSON hosts** (Cursor `~/.cursor/mcp.json` or project `.cursor/mcp.json`; Claude
Desktop `claude_desktop_config.json`; Cline / Windsurf / Continue):

```json
{
  "mcpServers": {
    "skill-forge": {
      "command": "skill-forge-mcp"
    }
  }
}
```

If a bare command doesn't resolve, use the explicit interpreter form pointing at
the installed package's server entry:

```json
{
  "mcpServers": {
    "skill-forge": {
      "command": "node",
      "args": ["/absolute/path/to/skill-forge/dist/mcp/server.js"]
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`, TOML):

```toml
[mcp_servers.skill-forge]
command = "skill-forge-mcp"
```

The server reads the same `~/.skill-forge/` config/env, so once the provider is
configured user-globally it works regardless of which agent spawns it.

## Installing this skill into a host

This folder (`skill-forge/` containing `SKILL.md` + `references/`) is the portable
unit. Copy or symlink it into the host's skills directory:

- **Claude Code:** `~/.claude/skills/skill-forge/` (user) or
  `.claude/skills/skill-forge/` (project).
- **Other Agent-Skills-compatible hosts:** their configured skills directory,
  keeping the folder name `skill-forge` so it matches the `name` in the
  frontmatter.

The skill shells out to the `skill-forge` CLI (or the MCP tool), so the engine
must be installed and a provider configured per the sections above.
